const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

// Global CORS Middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

function getStreamText(stream) {
  const name = stream.name || '';
  const title = stream.title || '';
  const desc = stream.description || '';
  const group = (stream.behaviorHints && stream.behaviorHints.bingeGroup) || '';
  return `${name} ${title} ${desc} ${group}`.toLowerCase();
}

function detectResolution(text) {
  if (/\b(2160p|4k|uhd)\b/i.test(text)) return '4k';
  if (/\b(1080p|fhd)\b/i.test(text)) return '1080p';
  if (/\b(720p|hd)\b/i.test(text)) return '720p';
  if (/\b(480p)\b/i.test(text)) return '480p';
  if (/\b(360p)\b/i.test(text)) return '360p';
  return 'unknown';
}

function detectSizeInBytes(text) {
  const match = text.match(/(\d+(?:\.\d+)?)\s*(gb|gib|mb|mib)\b/i);
  if (!match) return null;

  const val = parseFloat(match[1]);
  const unit = match[2].toLowerCase();

  if (unit.startsWith('g')) return val * 1024 * 1024 * 1024;
  if (unit.startsWith('m')) return val * 1024 * 1024;
  return null;
}

function sortStreams(streams, config) {
  if (!Array.isArray(streams) || streams.length === 0) return [];

  const userResPriority = (config.res && config.res.length > 0)
    ? config.res.map(r => r.trim().toLowerCase())
    : ['1080p', '4k', '720p', '480p', '360p'];

  return streams.sort((a, b) => {
    const textA = getStreamText(a);
    const textB = getStreamText(b);

    const providerA = (a.name || '').trim().toLowerCase();
    const providerB = (b.name || '').trim().toLowerCase();

    // Grouping strategy
    if (config.group === 'provider' && providerA !== providerB) {
      return providerA.localeCompare(providerB);
    }

    // Resolution priority
    const resA = detectResolution(textA);
    const resB = detectResolution(textB);

    if (resA !== resB) {
      let indexA = userResPriority.indexOf(resA);
      let indexB = userResPriority.indexOf(resB);

      if (indexA === -1) indexA = 999;
      if (indexB === -1) indexB = 999;

      if (indexA !== indexB) {
        return indexA - indexB;
      }
    }

    // File size priority
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

// Universal Router using raw URL parsing
app.get('*', async (req, res) => {
  const reqPath = req.path; // e.g. /BASE64/stream/movie/tt0111161.json

  // Handle Root URL (Serves Config HTML)
  if (reqPath === '/' || reqPath === '/index.html') {
    return res.sendFile(path.join(__dirname, '../public/index.html'));
  }

  // Split path into segments
  const segments = reqPath.split('/').filter(Boolean);

  if (segments.length < 2) {
    return res.status(400).json({ err: 'Invalid route' });
  }

  const rawConfig = segments[0];
  const config = parseConfig(rawConfig);

  if (!config || !config.target) {
    return res.status(400).json({ err: 'Invalid Base64 configuration' });
  }

  // Handle Manifest Request
  if (segments[1] === 'manifest.json') {
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
      console.error('Manifest Error:', error.message);
      return res.status(500).json({ err: 'Failed to connect to target manifest' });
    }
  }

  // Handle Stream Request (/BASE64/stream/:type/:id)
  if (segments[1] === 'stream' && segments.length >= 4) {
    const type = segments[2];
    
    // Reconstruct raw ID from remaining path segments (handles kitsu:123:1, tt123.json, etc.)
    const rawIdPath = segments.slice(3).join('/');
    const cleanId = rawIdPath.replace(/\.json$/, '');

    const targetBase = config.target.trim().replace(/\/$/, '').replace(/\/manifest\.json$/, '');

    const testUrls = [
      `${targetBase}/stream/${type}/${cleanId}.json`,
      `${targetBase}/stream/${type}/${cleanId}`,
      `${targetBase}/stream/${type}/${rawIdPath}`
    ];

    let streams = [];

    for (const url of testUrls) {
      try {
        console.log(`[Stream Proxy] Requesting target: ${url}`);
        const response = await http.get(url);
        
        if (response.data && Array.isArray(response.data.streams)) {
          streams = response.data.streams;
          console.log(`[Stream Proxy] Received ${streams.length} streams.`);
          break;
        }
      } catch (err) {
        console.log(`[Stream Proxy] Failed ${url}: ${err.message}`);
      }
    }

    if (streams.length > 0) {
      streams = sortStreams(streams, config);
    }

    res.setHeader('Content-Type', 'application/json');
    return res.json({ streams });
  }

  res.status(444).json({ err: 'Unknown Stremio action' });
});

module.exports = app;
