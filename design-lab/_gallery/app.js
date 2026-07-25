/* Chess# design lab: feel x style comparison gallery.
   Needs window.LAB from pages.js (generated snapshot of the ten directions). */

(function () {
  'use strict';

  var LAB = window.LAB;

  /* The vocabulary the lead extracted. Numbers are for the machine, names are
     for the owner, so every control speaks in names. */
  var NAMES = {
    '01': { feel: 'Flat nav, persistent readout',   style: 'Graphite instrument, amber signal', rate: 'immediate' },
    '02': { feel: 'Standing table of contents',     style: 'Warm graphite, gilt rule',          rate: 'immediate' },
    '03': { feel: 'Fixed header, numbered rows',    style: 'Night slate, signal amber',         rate: 'immediate' },
    '04': { feel: 'Fixed control panel',            style: 'Cabinet livery',                    rate: 'immediate' },
    '05': { feel: 'Docked command line',            style: 'Monochrome terminal',               rate: 'learnable' },
    '06': { feel: 'Lid stack navigation',           style: 'Walnut, felt and brass',            rate: 'learnable' },
    '07': { feel: 'Score bug and ticker frame',     style: 'Studio indigo and gold',            rate: 'immediate' },
    '08': { feel: 'Sheet set with keyed details',   style: 'Diazo negative draft',              rate: 'learnable' },
    '09': { feel: 'Dimmed stack, lit focus',        style: 'Sodium and petrol night',           rate: 'learnable' },
    '10': { feel: 'Right-edge binder tabs',         style: 'Graphite field notebook',           rate: 'learnable' }
  };

  /* Explicit, because '10' is a canonical array index and would sort itself to
     the front of Object.keys. */
  var NN = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'];

  var SCREENS = [
    { id: 'home',   label: 'Home' },
    { id: 'mobile', label: 'Home mobile' },
    { id: 'games',  label: 'Games' },
    { id: 'school', label: 'School' }
  ];

  var FILE_TO_SCREEN = {
    'home.html': 'home',
    'home.mobile.html': 'mobile',
    'games.html': 'games',
    'school.html': 'school'
  };

  var STORE = 'chess-sharp-design-lab-verdicts-v1';

  /* ------------------------------------------------------------------ state */

  var state = {
    screen: 'home',
    compare: false,
    aimed: 0,
    panes: [
      { feel: '01', style: '01', palette: '' },
      { feel: '03', style: '05', palette: '' }
    ]
  };

  var verdicts = load();

  function load() {
    try {
      var raw = localStorage.getItem(STORE);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify(verdicts));
    } catch (e) {
      toast('Could not write localStorage, verdicts are session only');
    }
  }

  /* ------------------------------------------------- palettes out of the css
     Read the palette names straight from the chosen style.css text rather than
     keeping a second list that can drift. */

  var palCache = {};

  function palettesFor(styleNN) {
    if (palCache[styleNN]) return palCache[styleNN];
    var css = LAB.dirs[styleNN].style;
    var re = new RegExp('\\[data-style=[\'"]' + styleNN + '[\'"]\\]\\s*\\[data-palette=[\'"]([a-zA-Z0-9_-]+)[\'"]\\]', 'g');
    var out = [], m;
    while ((m = re.exec(css))) {
      if (out.indexOf(m[1]) === -1) out.push(m[1]);
    }
    palCache[styleNN] = out;
    return out;
  }

  function normalisePalette(pane) {
    var pals = palettesFor(pane.style);
    if (!pals.length) pane.palette = '';
    else if (pals.indexOf(pane.palette) === -1) pane.palette = pals[0];
  }

  /* ------------------------------------------------------ the swap mechanic */

  function injected(styleNN, palette) {
    return '<script>(function(){var r=document.documentElement;' +
      'r.setAttribute("data-style",' + JSON.stringify(styleNN) + ');' +
      (palette
        ? 'r.setAttribute("data-palette",' + JSON.stringify(palette) + ');'
        : 'r.removeAttribute("data-palette");') +
      'document.addEventListener("click",function(e){' +
      'var t=e.target;var pb=t.closest?t.closest("[data-set-palette],[data-pal]"):null;' +
      'if(pb){var v=pb.getAttribute("data-set-palette")||pb.getAttribute("data-pal");' +
      'parent.postMessage({lab:"palette",value:v},"*");return;}' +
      'var a=t.closest?t.closest("a[href]"):null;if(!a)return;' +
      'var h=a.getAttribute("href")||"";if(!h||h.charAt(0)==="#")return;' +
      'e.preventDefault();parent.postMessage({lab:"nav",href:h},"*");' +
      '},true);}());<\/script>';
  }

  /* Take the FEEL's html, drop its own style.css link and put the chosen
     STYLE's token block there instead, inline its own feel.css in the same
     slot it already used, and rewrite the root element so data-style points at
     the chosen style. Every style.css scopes itself to [data-style="NN"], so
     the file swap alone paints nothing: both halves are required. */
  function buildDoc(pane, screen) {
    var feel = LAB.dirs[pane.feel];
    var style = LAB.dirs[pane.style];
    var html = feel.screens[screen];

    html = html.replace(/<link\b[^>]*href\s*=\s*(["'])style\.css\1[^>]*>/i, function () {
      return '<style data-lab="style-' + pane.style + '">\n' + style.style + '\n</style>';
    });

    html = html.replace(/<link\b[^>]*href\s*=\s*(["'])feel\.css\1[^>]*>/i, function () {
      return '<style data-lab="feel-' + pane.feel + '">\n' + feel.feel + '\n</style>';
    });

    html = html.replace(/<html\b([^>]*)>/i, function (m, attrs) {
      var a = attrs
        .replace(/\s+data-style\s*=\s*(["'])[^"']*\1/gi, '')
        .replace(/\s+data-palette\s*=\s*(["'])[^"']*\1/gi, '');
      return '<html' + a + ' data-style="' + pane.style + '"' +
        (pane.palette ? ' data-palette="' + pane.palette + '"' : '') + '>';
    });

    var tail = injected(pane.style, pane.palette);
    if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, tail + '</body>');
    else html += tail;

    return html;
  }

  /* ------------------------------------------------------- pairing notes */

  function fights(pane) {
    var out = [];
    var f = LAB.dirs[pane.feel], s = LAB.dirs[pane.style];
    if (f.badRefs.indexOf(pane.style) > -1) {
      out.push({ who: 'd' + pane.feel + ', author of this feel, flagged style ' + pane.style, text: f.badText });
    }
    if (s.badRefs.indexOf(pane.feel) > -1) {
      out.push({ who: 'd' + pane.style + ', author of this style, flagged feel ' + pane.feel, text: s.badText });
    }
    return out;
  }

  function agrees(pane) {
    var out = [];
    var f = LAB.dirs[pane.feel], s = LAB.dirs[pane.style];
    if (f.goodRefs.indexOf(pane.style) > -1) {
      out.push({ who: 'd' + pane.feel + ' recommends style ' + pane.style, text: f.goodText });
    }
    if (s.goodRefs.indexOf(pane.feel) > -1) {
      out.push({ who: 'd' + pane.style + ' recommends feel ' + pane.feel, text: s.goodText });
    }
    return out;
  }

  /* -------------------------------------------------------------- helpers */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function key(pane) { return pane.feel + '+' + pane.style; }

  function comboWords(pane) {
    return 'feel ' + pane.feel + ' ' + NAMES[pane.feel].feel +
      '  +  style ' + pane.style + ' ' + NAMES[pane.style].style +
      (pane.palette ? ' (' + pane.palette + ')' : '');
  }

  var toastTimer = null;
  function toast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  /* ------------------------------------------------------------ the pickers */

  function renderPickers() {
    var pane = state.panes[state.aimed];

    document.getElementById('aim').innerHTML = state.compare
      ? 'Pickers are aimed at <b>panel ' + (state.aimed ? 'B' : 'A') + '</b>. Click the other panel header to aim there.'
      : 'One panel. Feel and style move independently.';

    var fl = document.getElementById('feel-list');
    var sl = document.getElementById('style-list');
    fl.innerHTML = '';
    sl.innerHTML = '';

    NN.forEach(function (n) {
      var b = el('button', 'opt');
      b.type = 'button';
      b.setAttribute('aria-label', 'Feel ' + n + ', ' + NAMES[n].feel + ', ' + NAMES[n].rate);
      b.setAttribute('aria-pressed', String(n === pane.feel));
      b.appendChild(el('span', 'num', n));
      var box = el('span');
      box.appendChild(el('span', null, NAMES[n].feel));
      box.appendChild(el('span', 'rate ' + NAMES[n].rate, NAMES[n].rate));
      b.appendChild(box);
      b.addEventListener('click', function () { setPane({ feel: n }); });
      fl.appendChild(b);

      var c = el('button', 'opt');
      c.type = 'button';
      c.setAttribute('aria-label', 'Style ' + n + ', ' + NAMES[n].style);
      c.setAttribute('aria-pressed', String(n === pane.style));
      c.appendChild(el('span', 'num', n));
      var sbox = el('span');
      sbox.appendChild(el('span', null, NAMES[n].style));
      var pals = palettesFor(n);
      if (pals.length) sbox.appendChild(el('span', 'rate', pals.length + ' palettes'));
      c.appendChild(sbox);
      c.addEventListener('click', function () { setPane({ style: n }); });
      sl.appendChild(c);
    });

    /* Palette picker, only when the chosen style ships alternates. */
    var wrap = document.getElementById('pal-wrap');
    var list = document.getElementById('pal-list');
    var pals = palettesFor(pane.style);
    list.innerHTML = '';
    wrap.hidden = !pals.length;
    if (pals.length) {
      document.getElementById('pal-head').textContent =
        'Palette (style ' + pane.style + ')';
      pals.forEach(function (p) {
        var b = el('button', 'chip', p);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(p === pane.palette));
        b.addEventListener('click', function () { setPane({ palette: p }); });
        list.appendChild(b);
      });
    }

    renderNotes(pane);
  }

  function renderNotes(pane) {
    var box = document.getElementById('notes');
    box.innerHTML = '';
    box.appendChild(el('h2', null, 'Pairing notes'));

    if (pane.feel === pane.style) {
      var s = el('div', 'note self');
      s.appendChild(el('span', 'who', 'd' + pane.feel + ' as shipped'));
      s.appendChild(el('span', null, 'This is the direction its author built, feel and style together.'));
      box.appendChild(s);
    }

    var bad = fights(pane);
    bad.forEach(function (n) {
      var d = el('div', 'note fight');
      d.appendChild(el('span', 'who', 'Flagged as a fight: ' + n.who));
      d.appendChild(el('span', null, n.text));
      box.appendChild(d);
    });

    agrees(pane).forEach(function (n) {
      var d = el('div', 'note good');
      d.appendChild(el('span', 'who', n.who));
      d.appendChild(el('span', null, n.text));
      box.appendChild(d);
    });

    if (!bad.length && !agrees(pane).length && pane.feel !== pane.style) {
      box.appendChild(el('div', 'note', 'Neither author said anything about this pairing.'));
    }

    var det = el('details', 'raw');
    det.appendChild(el('summary', null, 'Both READMEs in full'));
    [['feel', pane.feel], ['style', pane.style]].forEach(function (pair) {
      var d = LAB.dirs[pair[1]];
      var p1 = el('p');
      p1.appendChild(el('b', null, 'd' + pair[1] + ' (' + pair[0] + ') combines well with: '));
      p1.appendChild(document.createTextNode(d.goodText || 'nothing recorded'));
      var p2 = el('p');
      p2.appendChild(el('b', null, 'd' + pair[1] + ' (' + pair[0] + ') fights with: '));
      p2.appendChild(document.createTextNode(d.badText || 'nothing recorded'));
      det.appendChild(p1);
      det.appendChild(p2);
    });
    box.appendChild(det);
  }

  /* -------------------------------------------------------------- the stage */

  function renderStage() {
    var stage = document.getElementById('stage');
    stage.innerHTML = '';
    var count = state.compare ? 2 : 1;
    for (var i = 0; i < count; i++) stage.appendChild(buildPane(i));
    fitDevices();
  }

  function buildPane(i) {
    var pane = state.panes[i];
    var wrap = el('div', 'pane' + (state.compare && i === state.aimed ? ' is-aimed' : ''));

    var head = el('div', 'pane-head');
    if (state.compare) {
      head.appendChild(el('span', 'pane-badge', i ? 'B' : 'A'));
      head.addEventListener('click', function (e) {
        if (e.target.closest('.verdicts')) return;
        state.aimed = i;
        renderPickers();
        renderStage();
      });
    }

    var combo = el('div', 'pane-combo');
    combo.innerHTML = '<b>' + NAMES[pane.feel].feel + '</b><span class="plus">on</span><b>' +
      NAMES[pane.style].style + '</b>' + (pane.palette ? ' <span class="plus">/ ' + pane.palette + '</span>' : '');
    head.appendChild(combo);

    if (fights(pane).length) head.appendChild(el('span', 'pane-flag', 'flagged fight'));

    var v = el('div', 'verdicts');
    ['keep', 'maybe', 'no'].forEach(function (name) {
      var b = el('button', null, name);
      b.type = 'button';
      b.dataset.v = name;
      var cur = verdicts[key(pane)];
      b.setAttribute('aria-pressed', String(!!cur && cur.v === name));
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        setVerdict(pane, name);
      });
      v.appendChild(b);
    });
    head.appendChild(v);
    wrap.appendChild(head);

    var isPhone = state.screen === 'mobile';
    var fw = el('div', 'frame-wrap ' + (isPhone ? 'phone' : 'desk'));
    var frame = el('iframe');
    frame.setAttribute('title', comboWords(pane));
    frame.srcdoc = buildDoc(pane, state.screen);

    if (isPhone) {
      var dev = el('div', 'device');
      dev.appendChild(frame);
      fw.appendChild(dev);
    } else {
      fw.appendChild(frame);
    }
    wrap.appendChild(fw);
    return wrap;
  }

  /* The 390x844 frame is taller than most windows, so scale it to fit rather
     than making the owner scroll a phone. */
  function fitDevices() {
    var devs = document.querySelectorAll('.device');
    for (var i = 0; i < devs.length; i++) {
      var d = devs[i];
      var avail = d.parentNode.clientHeight - 28;
      var s = Math.min(1, avail / 844);
      d.style.transform = s < 1 ? 'scale(' + s.toFixed(3) + ')' : 'none';
      d.parentNode.style.alignItems = 'flex-start';
    }
  }

  window.addEventListener('resize', fitDevices);

  function setPane(patch) {
    var pane = state.panes[state.aimed];
    Object.keys(patch).forEach(function (k) { pane[k] = patch[k]; });
    if (!patch.palette) normalisePalette(pane);
    renderPickers();
    renderStage();
  }

  function setVerdict(pane, name) {
    var k = key(pane);
    if (verdicts[k] && verdicts[k].v === name) delete verdicts[k];
    else verdicts[k] = { v: name, feel: pane.feel, style: pane.style, palette: pane.palette, at: stamp() };
    save();
    renderStage();
    renderSummary();
  }

  function stamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* ------------------------------------------------------------- summary */

  function sorted() {
    return Object.keys(verdicts).sort(function (a, b) {
      var x = verdicts[a], y = verdicts[b];
      return x.feel === y.feel ? (x.style < y.style ? -1 : 1) : (x.feel < y.feel ? -1 : 1);
    });
  }

  function exportText() {
    var lines = [];
    lines.push('Chess# design lab, feel x style verdicts');
    lines.push('exported ' + stamp() + ', snapshot ' + LAB.generated);
    var keys = sorted();
    lines.push(keys.length + ' of 100 combinations judged');
    lines.push('');
    ['keep', 'maybe', 'no'].forEach(function (name) {
      var group = keys.filter(function (k) { return verdicts[k].v === name; });
      lines.push(name.toUpperCase() + ' (' + group.length + ')');
      if (!group.length) lines.push('  none');
      group.forEach(function (k) {
        var e = verdicts[k];
        lines.push('  feel ' + e.feel + ' ' + NAMES[e.feel].feel +
          '  on  style ' + e.style + ' ' + NAMES[e.style].style +
          (e.palette ? ' [' + e.palette + ']' : '') +
          (fights({ feel: e.feel, style: e.style }).length ? '   (author flagged this as a fight)' : ''));
      });
      lines.push('');
    });
    return lines.join('\n');
  }

  function renderSummary() {
    var body = document.getElementById('summary-body');
    body.innerHTML = '';
    var keys = sorted();
    document.getElementById('summary-count').textContent =
      keys.length + ' of 100 combinations judged. Click any row to load it.';

    if (!keys.length) {
      body.appendChild(el('p', 'empty', 'Nothing judged yet. Use keep, maybe or no in a panel header.'));
    } else {
      ['keep', 'maybe', 'no'].forEach(function (name) {
        var group = keys.filter(function (k) { return verdicts[k].v === name; });
        if (!group.length) return;
        var g = el('div', 'vgroup ' + name);
        g.appendChild(el('h2', null, name + ' (' + group.length + ')'));
        group.forEach(function (k) {
          var e = verdicts[k];
          var row = el('button', 'vrow');
          row.type = 'button';
          row.appendChild(el('code', null, e.feel + '+' + e.style));
          var txt = el('span', null, NAMES[e.feel].feel + '  on  ' + NAMES[e.style].style +
            (e.palette ? ' / ' + e.palette : ''));
          row.appendChild(txt);
          row.appendChild(el('span', 'go', 'load'));
          row.addEventListener('click', function () {
            var pane = state.panes[state.aimed];
            pane.feel = e.feel;
            pane.style = e.style;
            pane.palette = e.palette || '';
            normalisePalette(pane);
            closeSummary();
            renderPickers();
            renderStage();
          });
          g.appendChild(row);
        });
        body.appendChild(g);
      });
    }

    document.getElementById('export').value = exportText();
  }

  function openSummary() {
    renderSummary();
    document.getElementById('overlay').hidden = false;
  }

  function closeSummary() {
    document.getElementById('overlay').hidden = true;
  }

  /* ---------------------------------------------------------------- chrome */

  function buildBar() {
    var sc = document.getElementById('screens');
    SCREENS.forEach(function (s) {
      var b = el('button', null, s.label);
      b.type = 'button';
      b.dataset.screen = s.id;
      b.setAttribute('aria-pressed', String(s.id === state.screen));
      b.addEventListener('click', function () {
        state.screen = s.id;
        syncPressed(sc, 'screen', s.id);
        renderStage();
      });
      sc.appendChild(b);
    });

    var md = document.getElementById('mode');
    [['single', 'One panel'], ['compare', 'Side by side']].forEach(function (m) {
      var b = el('button', null, m[1]);
      b.type = 'button';
      b.dataset.mode = m[0];
      b.setAttribute('aria-pressed', String((m[0] === 'compare') === state.compare));
      b.addEventListener('click', function () {
        state.compare = m[0] === 'compare';
        if (!state.compare) state.aimed = 0;
        syncPressed(md, 'mode', m[0]);
        renderPickers();
        renderStage();
      });
      md.appendChild(b);
    });
  }

  function syncPressed(root, attr, val) {
    var bs = root.querySelectorAll('button');
    for (var i = 0; i < bs.length; i++) {
      bs[i].setAttribute('aria-pressed', String(bs[i].dataset[attr] === val));
    }
  }

  /* Clicks inside a preview: the pages link to sibling files that do not exist
     next to index.html, so the injected script hands them here instead. */
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.lab === 'nav') {
      var file = String(d.href).split('/').pop();
      var screen = FILE_TO_SCREEN[file];
      if (screen) {
        state.screen = screen;
        syncPressed(document.getElementById('screens'), 'screen', screen);
        renderStage();
      } else {
        toast(file + ' was not one of the four screens built');
      }
    } else if (d.lab === 'palette') {
      var pane = state.panes[state.aimed];
      if (palettesFor(pane.style).indexOf(d.value) > -1) {
        pane.palette = d.value;
        renderPickers();
        renderStage();
      }
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeSummary();
  });

  function init() {
    document.getElementById('gen').textContent = 'snapshot ' + LAB.generated;
    buildBar();
    document.getElementById('btn-summary').addEventListener('click', openSummary);
    document.getElementById('btn-close').addEventListener('click', closeSummary);
    document.getElementById('overlay').addEventListener('click', function (e) {
      if (e.target.id === 'overlay') closeSummary();
    });
    document.getElementById('btn-copy').addEventListener('click', function () {
      var ta = document.getElementById('export');
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      if (!ok && navigator.clipboard) {
        navigator.clipboard.writeText(ta.value).then(function () { toast('Copied'); }, function () {
          toast('Copy blocked, select the text and copy by hand');
        });
        return;
      }
      toast(ok ? 'Copied' : 'Copy blocked, select the text and copy by hand');
    });
    document.getElementById('btn-clear').addEventListener('click', function () {
      if (!Object.keys(verdicts).length) return;
      if (!confirm('Erase every verdict?')) return;
      verdicts = {};
      save();
      renderSummary();
      renderStage();
    });

    state.panes.forEach(normalisePalette);
    renderPickers();
    renderStage();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}());
