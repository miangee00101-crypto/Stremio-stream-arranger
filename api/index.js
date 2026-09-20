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

function detectResolution(text) {
  const str = (text || '').toLowerCase();
  if (str.includes('2160p') || str.includes('4k') || str.includes('uhd')) return '4k';
  if (str.includes('1080p') || str.includes('fhd')) return '1080p';
  if (str.includes('720p') || str.includes('hd')) return '720p';
  if (str.includes('480p')) return '480p';
  if (str.includes('360p')) return '360p';
  return 'unknown';
}

function detectSizeInBytes(text) {
  const match = (text || '').match(/(\d+(?:\.\d+)?)\s*(gb|gib|mb|mib)/i);
  if (!match) return null;

  const val = parseFloat(match[1]);
  const unit = match[2].toLowerCase();

  if (unit.startsWith('g')) return val * 1024 * 1024 * 1024;
  if (unit.startsWith('m')) return val * 1024 * 1024;
  return null;
}

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

    if (config.group === 'provider' && providerA !== providerB) {
      return providerA.localeCompare(providerB);
    }

    if (resA !== resB) {
      let indexA = resPriority.indexOf(resA);
      let indexB = resPriority.indexOf(resB);

      if (indexA === -1) indexA = 999;
      if (indexB === -1) indexB = 999;

      if (indexA !== indexB) return indexA - indexB;
    }

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
    console.error('Manifest Fetch Error:', error.message);
    return res.status(500).json({ err: 'Failed to connect to target manifest' });
  }
});

// 2. Stream Endpoint (Catches all formats using Wildcard)
app.get('/:config/stream/:type/:id(*)', async (req, res) => {
  const config = parseConfig(req.params.config);
  if (!config || !config.target) return res.json({ streams: [] });

  const { type, id: rawId } = req.params;
  
  // Normalize the stream ID path
  const cleanId = rawId.replace(/\.json$/, '');
  const targetBase = config.target.trim().replace(/\/$/, '').replace(/\/manifest\.json$/, '');

  // Trial URLs to match how target add-ons expect paths
  const testUrls = [
    `${targetBase}/stream/${type}/${cleanId}.json`,
    `${targetBase}/stream/${type}/${cleanId}`,
    `${targetBase}/stream/${type}/${rawId}`
  ];

  let streams = [];

  for (const url of testUrls) {
    try {
      console.log(`Fetching from target: ${url}`);
      const response = await http.get(url);
      
      if (response.data && Array.isArray(response.data.streams)) {
        streams = response.data.streams;
        console.log(`Successfully retrieved ${streams.length} streams.`);
        break;
      }
    } catch (err) {
      console.log(`Failed attempt for ${url}: ${err.message}`);
    }
  }

  if (streams.length > 0) {
    streams = sortStreams(streams, config);
  }

  res.setHeader('Content-Type', 'application/json');
  return res.json({ streams });
});

module.exports = app;
