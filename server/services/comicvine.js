/**
 * Comic Vine API integration for fetching comic metadata.
 * API docs: https://comicvine.gamespot.com/api/documentation
 *
 * Requires a free API key from https://comicvine.gamespot.com/api/
 * Set COMICVINE_API_KEY in .env
 *
 * Rate limit: 200 requests per resource per hour.
 * We cache results in the database to minimize API calls.
 */

const { getDb } = require('../db');

const BASE_URL = 'https://comicvine.gamespot.com/api';
const USER_AGENT = 'Longbox/1.0';

// Simple in-memory rate limiter
let requestTimestamps = [];
const MAX_REQUESTS_PER_MINUTE = 10; // Stay well under the 200/hour limit

function getApiKey() {
  const key = process.env.COMICVINE_API_KEY;
  if (!key) {
    throw new Error('COMICVINE_API_KEY not set in .env — get one at https://comicvine.gamespot.com/api/');
  }
  return key;
}

async function rateLimitedFetch(url) {
  const now = Date.now();
  // Remove timestamps older than 1 minute
  requestTimestamps = requestTimestamps.filter(t => now - t < 60000);

  if (requestTimestamps.length >= MAX_REQUESTS_PER_MINUTE) {
    const waitMs = 60000 - (now - requestTimestamps[0]) + 100;
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }

  requestTimestamps.push(Date.now());

  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT }
  });

  if (!response.ok) {
    throw new Error(`Comic Vine API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (data.status_code !== 1) {
    throw new Error(`Comic Vine API error: ${data.error}`);
  }

  return data;
}

/**
 * Search for a volume (series) by name.
 * Returns top results with id, name, publisher, start_year, issue_count, image, description.
 */
async function searchVolumes(query, limit = 10) {
  const apiKey = getApiKey();
  const url = `${BASE_URL}/search/?api_key=${apiKey}&format=json&resources=volume&query=${encodeURIComponent(query)}&limit=${limit}&field_list=id,name,publisher,start_year,count_of_issues,image,description,aliases`;

  const data = await rateLimitedFetch(url);
  return data.results.map(v => ({
    comicvine_id: v.id,
    name: v.name,
    publisher: v.publisher?.name || null,
    start_year: v.start_year,
    issue_count: v.count_of_issues,
    image_url: v.image?.medium_url || v.image?.small_url || null,
    description: v.description,
    aliases: v.aliases,
  }));
}

/**
 * Get detailed volume (series) info by Comic Vine volume ID.
 */
async function getVolume(volumeId) {
  const apiKey = getApiKey();
  const url = `${BASE_URL}/volume/4050-${volumeId}/?api_key=${apiKey}&format=json&field_list=id,name,publisher,start_year,count_of_issues,image,description,issues`;

  const data = await rateLimitedFetch(url);
  const v = data.results;

  return {
    comicvine_id: v.id,
    name: v.name,
    publisher: v.publisher?.name || null,
    start_year: v.start_year,
    issue_count: v.count_of_issues,
    image_url: v.image?.medium_url || null,
    description: v.description,
    issues: (v.issues || []).map(i => ({
      comicvine_id: i.id,
      name: i.name,
      issue_number: i.issue_number,
    })),
  };
}

/**
 * Get detailed issue info by Comic Vine issue ID.
 */
async function getIssue(issueId) {
  const apiKey = getApiKey();
  const url = `${BASE_URL}/issue/4000-${issueId}/?api_key=${apiKey}&format=json&field_list=id,name,issue_number,volume,cover_date,description,image,character_credits,person_credits,story_arc_credits`;

  const data = await rateLimitedFetch(url);
  const i = data.results;

  return {
    comicvine_id: i.id,
    name: i.name,
    issue_number: i.issue_number,
    volume_name: i.volume?.name || null,
    cover_date: i.cover_date,
    description: i.description,
    image_url: i.image?.medium_url || null,
    characters: (i.character_credits || []).map(c => c.name),
    creators: (i.person_credits || []).map(p => ({ name: p.name, role: p.role })),
    story_arcs: (i.story_arc_credits || []).map(a => a.name),
  };
}

/**
 * Search for issues within a specific volume.
 */
async function getVolumeIssues(volumeId, limit = 100, offset = 0) {
  const apiKey = getApiKey();
  const url = `${BASE_URL}/issues/?api_key=${apiKey}&format=json&filter=volume:${volumeId}&limit=${limit}&offset=${offset}&sort=issue_number:asc&field_list=id,name,issue_number,cover_date,image,description`;

  const data = await rateLimitedFetch(url);
  return data.results.map(i => ({
    comicvine_id: i.id,
    name: i.name,
    issue_number: i.issue_number,
    cover_date: i.cover_date,
    image_url: i.image?.medium_url || null,
    description: i.description,
  }));
}

/**
 * Match a local series to a Comic Vine volume and save metadata.
 * This links the series in the DB to a Comic Vine volume ID.
 */
async function matchSeries(seriesId, comicvineVolumeId) {
  const db = getDb();
  const volume = await getVolume(comicvineVolumeId);

  db.prepare(`
    UPDATE series SET
      comicvine_id = ?,
      description = ?,
      publisher = ?,
      start_year = ?
    WHERE id = ?
  `).run(volume.comicvine_id, volume.description, volume.publisher, volume.start_year, seriesId);

  // Try to match individual issues by issue number
  const localIssues = db.prepare('SELECT * FROM issues WHERE series_id = ?').all(seriesId);
  const remoteIssues = await getVolumeIssues(comicvineVolumeId);

  let matched = 0;
  for (const local of localIssues) {
    if (local.issue_number == null) continue;

    const remote = remoteIssues.find(r => parseFloat(r.issue_number) === local.issue_number);
    if (remote) {
      db.prepare(`
        UPDATE issues SET
          comicvine_id = ?,
          description = ?,
          cover_date = ?
        WHERE id = ?
      `).run(remote.comicvine_id, remote.description, remote.cover_date, local.id);
      matched++;
    }
  }

  return { volume, matchedIssues: matched, totalLocalIssues: localIssues.length };
}

/**
 * Fetch full metadata for a single issue by its Comic Vine ID.
 * Saves characters, creators, story arcs to the DB.
 */
async function enrichIssue(issueId) {
  const db = getDb();
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(issueId);

  if (!issue || !issue.comicvine_id) {
    throw new Error('Issue not matched to Comic Vine');
  }

  const remote = await getIssue(issue.comicvine_id);

  db.prepare(`
    UPDATE issues SET
      description = ?,
      cover_date = ?,
      characters = ?,
      creators = ?,
      story_arcs = ?
    WHERE id = ?
  `).run(
    remote.description,
    remote.cover_date,
    JSON.stringify(remote.characters),
    JSON.stringify(remote.creators),
    JSON.stringify(remote.story_arcs),
    issueId
  );

  return remote;
}

/**
 * Get person (creator) info by Comic Vine person ID.
 * Returns name, image, description, and volume_credits.
 */
async function getPerson(personId) {
  const apiKey = getApiKey();
  const url = `${BASE_URL}/person/4040-${personId}/?api_key=${apiKey}&format=json&field_list=id,name,image,birth,death,description,gender,country,aliases,volume_credits`;

  const data = await rateLimitedFetch(url);
  const p = data.results;

  return {
    id: p.id,
    name: p.name,
    image_url: p.image?.medium_url || p.image?.small_url || null,
    image_large_url: p.image?.super_url || p.image?.screen_large_url || p.image?.medium_url || null,
    birth: p.birth || null,
    death: p.death || null,
    description: p.description || null,
    gender: p.gender,
    country: p.country || null,
    aliases: p.aliases || null,
    volume_credits: (p.volume_credits || []).map(v => ({
      id: v.id,
      name: v.name,
      site_detail_url: v.site_detail_url || null,
    })),
  };
}

module.exports = {
  searchVolumes,
  getVolume,
  getIssue,
  getVolumeIssues,
  matchSeries,
  enrichIssue,
  getPerson,
};
