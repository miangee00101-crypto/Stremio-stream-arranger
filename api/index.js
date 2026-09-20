const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  next();
});

// Serve the web UI at root
app.use(express.static(path.join(__dirname, '../public')));

// Helper: Extract config from Base64 path segment
function parseConfig(encoded) {
  try {
    const jsonStr = Buffer.from(encoded, 'base64').toString('utf-8');
    return JSON.parse(jsonStr);
  } catch (e) {
    return null;
  }
}

// Helper: Extract resolution from text
function detectResolution(text) {
  const str = text.toLowerCase();
  if (str.includes('2160p') || str.includes('4k') || str.includes('uhd')) return '4k';
  if (str.includes('1080p') || str.includes('fhd')) return '1080p';
  if (str.includes('720p') || str.includes('hd')) return '720p';
  if (str.includes('480p')) return '480p';
  if (str.includes('360p')) return '360p';
  return 'unknown';
}

// Helper: Extract file size in Bytes from stream title/description
function detectSizeInBytes(text) {
  // Regex to capture patterns like 1.5 GB, 700 MB, 2.3GiB
  const match = text.match(/(\d+(?:\.\d+)?)\s*(gb|gib|mb|mib)/i);
  if (!match) return null;

  const val = parseFloat(match[1]);
  const unit = match[2].toLowerCase();

  if (unit.startsWith('g')) return val * 1024 * 1024 * 1024;
  if (unit.startsWith('m')) return val * 1024 * 1024;
  return null;
}

// Sorting Engine
function sortStreams(streams, config) {
  if (!Array.isArray(streams)) return [];

  const resPriority = config.res || ['1080p', '4k', '720p', '480p', '360p'];

  return streams.sort((a, b) => {
    const textA = `${a.name || ''} ${a.title || ''} ${a.description || ''}`;
    const textB = `${b.name || ''} ${b.title || ''} ${b.description || ''}`;

    const resA = detectResolution(textA);
    const resB = detectResolution(textB);

    const providerA = (a.name || '').trim().toLowerCase();
    const providerB = (b.name || '').trim().toLowerCase();

    // 1. Primary Grouping logic
    if (config.group === 'provider' && providerA !== providerB) {
      return providerA.localeCompare(providerB);
    }

    // 2. Resolution Ranking
    if (resA !== resB) {
      let indexA = resPriority.indexOf(resA);
      let indexB = resPriority.indexOf(resB);

      if (indexA === -1) indexA = 999;
      if (indexB === -1) indexB = 999;

      if (indexA !== indexB) return indexA - indexB;
    }

    // 3. File Size Sorting (Secondary or Tie-breaker)
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

// 1. Dynamic Manifest Endpoint
app.get('/:config/manifest.json', async (req, res) => {
  const config = parseConfig(req.params.config);
  if (!config) return res.status(400).json({ err: 'Invalid configuration' });

  try {
    const targetUrl = `${config.target}/manifest.json`;
    const response = await axios.get(targetUrl);
    const manifest = response.data;

    // Apply custom name and unique ID
    manifest.id = `org.custom.arranger.${Buffer.from(config.target).toString('hex').slice(0, 8)}`;
    manifest.name = config.name || 'Arranged Streams';
    manifest.description = `Custom arranged proxy for ${config.target}`;

    res.json(manifest);
  } catch (error) {
    res.status(500).json({ err: 'Failed to reach original add-on manifest' });
  }
});

// 2. Dynamic Stream Endpoint
app.get('/:config/stream/:type/:id.json', async (req, res) => {
  const config = parseConfig(req.params.config);
  if (!config) return res.status(400).json({ err: 'Invalid configuration' });

  const { type, id } = req.params;

  try {
    const targetUrl = `${config.target}/stream/${type}/${id}`;
    const response = await axios.get(targetUrl);
    const data = response.data;

    if (data && data.streams) {
      data.streams = sortStreams(data.streams, config);
    }

    res.json(data);
  } catch (error) {
    res.json({ streams: [] });
  }
});

module.exports = app;
