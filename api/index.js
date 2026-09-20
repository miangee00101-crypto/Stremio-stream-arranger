const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.static(path.join(__dirname, '../public')));

function parseConfig(encoded) {
  try {
    const jsonStr = Buffer.from(encoded, 'base64').toString('utf-8');
    return JSON.parse(jsonStr);
  } catch (e) {
    return null;
  }
}

// 1. Combine all stream fields into a single search text
function getStreamText(stream) {
  const name = stream.name || '';
  const title = stream.title || '';
  const desc = stream.description || '';
  const group = (stream.behaviorHints && stream.behaviorHints.bingeGroup) || '';
  
  return `${name} ${title} ${desc} ${group}`.toLowerCase();
}

// 2. Exact resolution detector
function detectResolution(text) {
  if (/\b(2160p|4k|uhd)\b/i.test(text)) return '4k';
  if (/\b(1080p|fhd)\b/i.test(text)) return '1080p';
  if (/\b(720p|hd)\b/i.test(text)) return '720p';
  if (/\b(480p)\b/i.test(text)) return '480p';
  if (/\b(360p)\b/i.test(text)) return '360p';
  return 'unknown';
}

// 3. Size detector in Bytes
function detectSizeInBytes(text) {
  const match = text.match(/(\d+(?:\.\d+)?)\s*(gb|gib|mb|mib)\b/i);
  if (!match) return null;

  const val = parseFloat(match[1]);
  const unit = match[2].toLowerCase();

  if (unit.startsWith('g')) return val * 1024 * 1024 * 1024;
  if (unit.startsWith('m')) return val * 1024 * 1024;
  return null;
}

// 4. Enhanced Sorting Engine
function sortStreams(streams, config) {
  if (!Array.isArray(streams) || streams.length === 0) return [];

  // Parse user requested priority or set fallback
  const userResPriority = (config.res && config.res.length > 0)
    ? config.res.map(r => r.trim().toLowerCase())
    : ['1080p', '4k', '720p', '480p', '360p'];

  return streams.sort((a, b) => {
    const textA = getStreamText(a);
    const textB = getStreamText(b);

    const providerA = (a.name || '').trim().toLowerCase();
    const providerB = (b.name || '').trim().toLowerCase();

    // Strategy 1: Provider Grouping
    if (config.group === 'provider' && providerA !== providerB) {
      return providerA.localeCompare(providerB);
    }

    // Strategy 2: Resolution Ordering
    const resA = detectResolution(textA);
    const resB = detectResolution(textB);

    if (resA !== resB) {
      let indexA = userResPriority.indexOf(resA);
      let indexB = userResPriority.indexOf(resB);

      // Place unknown resolutions at the very bottom
      if (indexA === -1) indexA = 999;
      if (indexB === -1) indexB = 999;

      if (indexA !== indexB) {
        return indexA - indexB; // Lower index = higher priority
      }
    }

    // Strategy 3: File Size Ordering
    if (config.size && config.size !== 'none') {
      const sizeA = detectSizeInBytes(textA);
      const sizeB = detectSizeInBytes(textB);

      if (sizeA !== null && sizeB !== null && sizeA !== sizeB) {
        if (config.size === 'smaller') return sizeA - sizeB;
        if (config.size === 'larger') return sizeB - sizeA;
      }
    }

    return 0;
  });
}

const http = axios.create({
  timeout: 12000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*'
  }
});

// 1. Manifest Endpoint
app.get('/:config/manifest.json', async (req, res) => {
  const config = parseConfig(req.params.config);
  
  if (!config || !config.target) {
    return res.status(400).json({ err: 'Invalid configuration' });
  }

  let targetBase = config.target.trim().replace(/\/$/, '');
  if (!targetBase.endsWith('/manifest.json')) {
    targetBase = `${targetBase}/manifest.json`;
  }

  try {
    const response = await http.get(targetBase);
    const manifest = response.data;

    manifest.id = `org.custom.arranger.${Buffer.from(config.target).toString('hex').slice(0, 10)}`;
    manifest.name = config.name || 'Arranged Streams';
    manifest.description = 'Custom sorted stream proxy.';

    res.setHeader('Content-Type', 'application/json');
    return res.json(manifest);
  } catch (error) {
    return res.status(500).json({ err: 'Failed to connect to target manifest' });
  }
});

// 2. Stream Endpoint
app.get('/:config/stream/:type/:id(*)', async (req, res) => {
  const config = parseConfig(req.params.config);
  if (!config || !config.target) return res.json({ streams: [] });

  const { type, id: rawId } = req.params;
  const cleanId = rawId.replace(/\.json$/, '');
  const targetBase = config.target.trim().replace(/\/$/, '').replace(/\/manifest\.json$/, '');

  const testUrls = [
    `${targetBase}/stream/${type}/${cleanId}.json`,
    `${targetBase}/stream/${type}/${cleanId}`,
    `${targetBase}/stream/${type}/${rawId}`
  ];

  let streams = [];

  for (const url of testUrls) {
    try {
      const response = await http.get(url);
      if (response.data && Array.isArray(response.data.streams)) {
        streams = response.data.streams;
        break;
      }
    } catch (err) {
      // Continue trying next path option
    }
  }

  if (streams.length > 0) {
    streams = sortStreams(streams, config);
  }

  res.setHeader('Content-Type', 'application/json');
  return res.json({ streams });
});

module.exports = app;
