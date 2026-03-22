const express = require('express');
const { searchVolumes, getVolume, getIssue, matchSeries, enrichIssue, getPerson } = require('../services/comicvine');
const { getDb } = require('../db');

const router = express.Router();

// GET /api/comicvine/search?q=Batman — search Comic Vine for volumes
router.get('/search', async (req, res) => {
  const { q, limit = 10 } = req.query;
  if (!q) {
    return res.status(400).json({ error: 'Query parameter "q" is required' });
  }

  try {
    const results = await searchVolumes(q, parseInt(limit, 10));
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/comicvine/volume/:id — get volume details from Comic Vine
router.get('/volume/:id', async (req, res) => {
  try {
    const volume = await getVolume(req.params.id);
    res.json(volume);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/comicvine/issue/:id — get issue details from Comic Vine
router.get('/issue/:id', async (req, res) => {
  try {
    const issue = await getIssue(req.params.id);
    res.json(issue);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/comicvine/match/:seriesId — match a local series to a Comic Vine volume
router.post('/match/:seriesId', async (req, res) => {
  const { comicvine_volume_id } = req.body;
  if (!comicvine_volume_id) {
    return res.status(400).json({ error: 'comicvine_volume_id is required' });
  }

  try {
    const result = await matchSeries(parseInt(req.params.seriesId, 10), comicvine_volume_id);
    res.json({
      message: 'Series matched successfully',
      volume: result.volume.name,
      publisher: result.volume.publisher,
      matchedIssues: result.matchedIssues,
      totalLocalIssues: result.totalLocalIssues,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/comicvine/enrich/:issueId — fetch full metadata for a matched issue
router.post('/enrich/:issueId', async (req, res) => {
  try {
    const result = await enrichIssue(parseInt(req.params.issueId, 10));
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/comicvine/person/:id — get person (creator) details from Comic Vine
router.get('/person/:id', async (req, res) => {
  try {
    const person = await getPerson(req.params.id);
    res.json(person);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/comicvine/auto-match/:seriesId — search Comic Vine and auto-match the best result
router.post('/auto-match/:seriesId', async (req, res) => {
  const db = getDb();
  const series = db.prepare('SELECT * FROM series WHERE id = ?').get(req.params.seriesId);

  if (!series) {
    return res.status(404).json({ error: 'Series not found' });
  }

  try {
    // Search Comic Vine for the series name
    const results = await searchVolumes(series.name, 5);

    if (results.length === 0) {
      return res.json({ matched: false, message: 'No Comic Vine results found', candidates: [] });
    }

    // Return candidates so the user can pick, or auto-match the best one
    const { auto } = req.query;
    if (auto === 'true') {
      // Auto-match the first result
      const best = results[0];
      const matchResult = await matchSeries(series.id, best.comicvine_id);
      return res.json({
        matched: true,
        volume: matchResult.volume.name,
        publisher: matchResult.volume.publisher,
        matchedIssues: matchResult.matchedIssues,
        totalLocalIssues: matchResult.totalLocalIssues,
      });
    }

    // Return candidates for manual selection
    res.json({ matched: false, candidates: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
