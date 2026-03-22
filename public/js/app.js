/* ============================================
   Longbox — Shared Utilities
   ============================================ */

/** Escape HTML to prevent XSS */
function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

/** Strip HTML tags from Comic Vine descriptions */
function stripHtml(html) {
  if (!html) return '';
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.textContent || '';
}

/** Format file size */
function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/** Get URL query param */
function getParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

/** Debounce */
function debounce(fn, ms) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), ms);
  };
}

/** Build thumbnail URL */
function thumbUrl(thumbPath) {
  return thumbPath ? `/api/thumbnails/${thumbPath}` : null;
}

// Global progress data — loaded once, used by card builders
let _progressData = null;

async function loadProgressData() {
  try {
    const res = await fetch('/api/progress/summary');
    _progressData = await res.json();
  } catch (e) {
    _progressData = { issues: {}, series: {} };
  }
  return _progressData;
}

function getSeriesProgress(seriesId) {
  return _progressData && _progressData.series[seriesId] || null;
}

function getIssueProgress(issueId) {
  return _progressData && _progressData.issues[issueId] || null;
}

/** Build a series card HTML */
function seriesCard(s) {
  const thumb = thumbUrl(s.thumbnail_path);
  const prog = getSeriesProgress(s.id);
  let readBadge = '';
  let readClass = '';

  let progressBar = '';

  if (prog) {
    if (prog.allRead) {
      readClass = ' is-read';
    }
    if (prog.read > 0) {
      const pct = Math.round((prog.read / prog.total) * 100);
      progressBar = `<div class="series-progress"><div class="series-progress-fill" style="width:${pct}%"></div></div>`;
    }
  }

  // Checkmark for fully read series (same style as issue cards)
  const readToggle = prog && prog.allRead
    ? '<div class="read-toggle" data-is-read="1" style="pointer-events:none;"></div>'
    : '';

  return `
    <a class="card${readClass}" href="/series.html?id=${s.id}">
      <div class="card-img-wrap">
        ${thumb
          ? `<img src="${thumb}" alt="${esc(s.name)}" loading="lazy">`
          : `<div class="card-placeholder">&#128218;</div>`
        }
        ${readToggle}
        <span class="card-badge">${s.issue_count}</span>
        ${progressBar}
      </div>
      <div class="card-info">
        <h3 title="${esc(s.name)}">${esc(s.name)}</h3>
        <span class="meta">${s.publisher ? esc(s.publisher) : ''} ${s.start_year ? '&middot; ' + esc(s.start_year) : ''}</span>
      </div>
    </a>`;
}

/** Build an issue card HTML — supports variant cover rotation */
function issueCard(issue) {
  const num = issue.issue_number != null ? '#' + issue.issue_number : '';
  const hasVariants = issue.variants && issue.variants.length > 0;

  // Collect all cover thumbnails (primary + variants)
  const allCovers = [{ id: issue.id, thumb: issue.thumbnail_path, title: issue.title }];
  if (hasVariants) {
    issue.variants.forEach(v => {
      allCovers.push({ id: v.id, thumb: v.thumbnail_path, title: v.title });
    });
  }

  const primaryThumb = thumbUrl(issue.thumbnail_path);
  const cardId = `issue-card-${issue.id}`;

  // Read status
  const prog = getIssueProgress(issue.id);
  let readClass = '';
  let isRead = false;
  if (prog && prog.isRead) {
    readClass = ' is-read';
    isRead = true;
  }

  // Clickable read badge on cover — toggles read/unread
  const readBadge = `<button class="read-toggle" data-issue-id="${issue.id}" data-is-read="${isRead ? '1' : '0'}" title="${isRead ? 'Mark as unread' : 'Mark as read'}">${isRead ? '&#10003;' : ''}</button>`;
  const markReadBtn = '';

  // Build stacked cover images for rotation
  const coverImgs = allCovers.map((c, i) => {
    const src = thumbUrl(c.thumb);
    return src
      ? `<img src="${src}" alt="${esc(c.title)}" loading="lazy" class="variant-cover ${i === 0 ? 'active' : ''}" data-index="${i}" data-issue-id="${c.id}">`
      : '';
  }).filter(Boolean).join('');

  const variantBadge = hasVariants
    ? `<span class="card-badge variant-badge" title="${allCovers.length} covers">${allCovers.length} covers</span>`
    : '';

  const variantDots = hasVariants
    ? `<div class="variant-dots">${allCovers.map((_, i) =>
        `<span class="variant-dot ${i === 0 ? 'active' : ''}" data-index="${i}"></span>`
      ).join('')}</div>`
    : '';

  return `
    <div class="card${readClass}" id="${cardId}" data-primary-id="${issue.id}" ${hasVariants ? 'data-has-variants="true"' : ''}>
      <a href="/reader.html?id=${issue.id}" class="card-link">
        <div class="card-img-wrap">
          ${coverImgs || (primaryThumb
            ? `<img src="${primaryThumb}" alt="${esc(issue.title)}" loading="lazy" class="variant-cover active">`
            : `<div class="card-placeholder">&#128214;</div>`
          )}
          ${readBadge}
          ${variantBadge}
          ${variantDots}
        </div>
      </a>
      <div class="card-info">
        <div class="card-info-row">
          <h3 title="${esc(issue.title)}">${num || esc(issue.title)}</h3>
          ${markReadBtn}
        </div>
        <span class="meta">${issue.cover_date ? esc(issue.cover_date) : formatSize(issue.file_size)}</span>
      </div>
    </div>`;
}

/** Initialize variant cover rotation on all cards */
function initVariantRotation() {
  document.querySelectorAll('.card[data-has-variants]').forEach(card => {
    const covers = card.querySelectorAll('.variant-cover');
    const dots = card.querySelectorAll('.variant-dot');
    const link = card.querySelector('.card-link');
    if (covers.length <= 1) return;

    let current = 0;
    let interval = null;

    function showCover(index) {
      covers.forEach((c, i) => c.classList.toggle('active', i === index));
      dots.forEach((d, i) => d.classList.toggle('active', i === index));
      current = index;
      // Update the link to point to the currently shown variant
      const issueId = covers[index].dataset.issueId;
      if (issueId && link) link.href = `/reader.html?id=${issueId}`;
    }

    function startRotation() {
      if (interval) return;
      interval = setInterval(() => {
        showCover((current + 1) % covers.length);
      }, 800);
    }

    function stopRotation() {
      clearInterval(interval);
      interval = null;
    }

    card.addEventListener('mouseenter', startRotation);
    card.addEventListener('mouseleave', () => {
      stopRotation();
      showCover(0);
    });

    // Click dots to pick a specific cover
    dots.forEach(dot => {
      dot.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        stopRotation();
        showCover(parseInt(dot.dataset.index));
      });
    });
  });
}
