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
    <div class="card${readClass}" style="position:relative;">
      <a href="/series.html?id=${s.id}" style="text-decoration:none;color:inherit;display:block;">
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
      </a>
      <button class="card-add-list" onclick="event.preventDefault();event.stopPropagation();addSeriesToList(this,${s.id});" title="Add to List">&#43;</button>
    </div>`;
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

// Add all issues in a series to a reading list (popover from button)
function addSeriesToList(btn, seriesId) {
  var old = document.getElementById('seriesListPop');
  if (old) { old.remove(); return; }

  fetch('/api/lists').then(function(r) { return r.json(); }).then(function(lists) {
    var pop = document.createElement('div');
    pop.id = 'seriesListPop';
    pop.style.cssText = 'position:fixed;z-index:200;background:rgba(20,20,20,0.95);backdrop-filter:blur(12px);border-radius:8px;padding:0.5rem 0;min-width:180px;max-height:260px;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.6);';

    var html = '<div style="font-size:0.7rem;color:#888;text-transform:uppercase;letter-spacing:0.5px;padding:0.4rem 0.75rem;">Add series to list</div>';
    for (var i = 0; i < lists.length; i++) {
      html += '<div data-lid="' + lists[i].id + '" style="padding:0.45rem 0.75rem;cursor:pointer;font-size:0.82rem;color:#ccc;transition:background 0.15s;">' + esc(lists[i].name) + '</div>';
    }
    if (!lists.length) html += '<div style="padding:0.45rem 0.75rem;color:#666;font-size:0.78rem;">No lists yet.</div>';
    pop.innerHTML = html;

    // Position near the button
    var rect = btn.getBoundingClientRect();
    pop.style.left = Math.min(rect.left, window.innerWidth - 200) + 'px';
    pop.style.top = Math.max(0, rect.bottom + 4) + 'px';

    document.body.appendChild(pop);

    pop.addEventListener('click', function(e) {
      var item = e.target.closest('[data-lid]');
      if (!item) return;
      var listId = item.dataset.lid;
      item.textContent = 'Adding...';

      fetch('/api/series/' + seriesId).then(function(r) { return r.json(); }).then(function(data) {
        var issues = data.issues || [];
        var chain = Promise.resolve();
        var added = 0;
        issues.forEach(function(iss) {
          chain = chain.then(function() {
            return fetch('/api/lists/' + listId + '/items', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ issue_id: iss.id }),
            }).then(function(r) { if (r.ok) added++; });
          });
        });
        chain.then(function() {
          item.textContent = 'Added ' + added + ' issues';
          setTimeout(function() { pop.remove(); }, 1200);
        });
      });
    });

    setTimeout(function() {
      document.addEventListener('click', function closePop(e) {
        if (!pop.contains(e.target) && e.target !== btn) {
          pop.remove();
          document.removeEventListener('click', closePop);
        }
      });
    }, 0);
  });
}
