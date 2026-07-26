/* nodechess SHELL behaviour. One file, loaded by all ten pages.

   Everything here is chrome. Nav, palette, rail collapse, segmented controls,
   chips, tabs and disclosures respond; nothing plays chess. There is no move
   validation, no engine, no puzzle checker and no clock in this build, on
   purpose: the board is a picture of a position and the room around it is what
   is being shown.

   Before this file existed the rail toggle was pasted into ten pages and the
   palette swatches only existed on settings, where they set aria-pressed and
   changed nothing. Both are here now, once.

   The palette is written to localStorage and re-applied from the inline head
   snippet on the next page, which is why a theme survives navigation. The head
   snippet has to be inline and has to run before first paint, or the page
   flashes the default palette before repainting to the chosen one. */

(function () {
  'use strict'

  var root = document.documentElement
  var STORE_PAL = 'nc.palette'
  var STORE_RAIL = 'nc.rail'

  function read(key) {
    try {
      return localStorage.getItem(key)
    } catch (e) {
      return null
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, value)
    } catch (e) {}
  }

  /* ---------- palette ----------

     cold-iron-bone is the default and is declared on :root in tokens.css, so it
     is the one value that clears the attribute rather than setting it. The
     palettes.css block of the same name is identical to that default, so either
     route paints the same pixels. Clearing is preferred because a page with no
     attribute is the honest description of the shipping default.

     Nothing in here touches the board. --sq-light, --sq-dark, --sq-mark,
     --piece-white and --piece-black are declared once in tokens.css and no
     palette block redeclares them, so a switch repaints the chrome and leaves
     all 64 squares and all 32 pieces exactly where they were. */
  var DEFAULT_PALETTE = 'cold-iron-bone'

  function currentPalette() {
    return root.getAttribute('data-palette') || DEFAULT_PALETTE
  }

  function applyPalette(name) {
    if (!name || name === DEFAULT_PALETTE) root.removeAttribute('data-palette')
    else root.setAttribute('data-palette', name)
    write(STORE_PAL, name || DEFAULT_PALETTE)
    syncPaletteControls()
  }

  function syncPaletteControls() {
    var now = currentPalette()
    var all = document.querySelectorAll('[data-pal]')
    for (var i = 0; i < all.length; i++) {
      all[i].setAttribute('aria-pressed', all[i].getAttribute('data-pal') === now ? 'true' : 'false')
    }
  }

  document.addEventListener('click', function (e) {
    var sw = e.target.closest ? e.target.closest('[data-pal]') : null
    if (!sw) return
    e.preventDefault()
    applyPalette(sw.getAttribute('data-pal'))
  })

  syncPaletteControls()

  /* ---------- rail collapse ---------- */

  var toggle = document.querySelector('[data-rail-toggle]')
  if (toggle) {
    var label = function () {
      var min = root.getAttribute('data-rail') === 'min'
      toggle.title = min ? 'Expand' : 'Collapse'
      toggle.setAttribute('aria-expanded', min ? 'false' : 'true')
    }
    toggle.addEventListener('click', function () {
      var min = root.getAttribute('data-rail') === 'min'
      if (min) root.removeAttribute('data-rail')
      else root.setAttribute('data-rail', 'min')
      write(STORE_RAIL, min ? 'full' : 'min')
      label()
    })
    label()
  }

  /* ---------- segmented controls and chip groups ----------

     One handler for both. A [data-segs] group is single choice, the way a
     segmented control is; a [data-chips] group is multi choice, the way a
     filter field is. Marked with aria-pressed either way, which is what the
     shell styles read. */

  document.addEventListener('click', function (e) {
    if (!e.target.closest) return

    var seg = e.target.closest('.seg')
    if (seg) {
      var segGroup = seg.closest('[data-segs]')
      if (segGroup) {
        var segs = segGroup.querySelectorAll('.seg')
        for (var i = 0; i < segs.length; i++) {
          segs[i].setAttribute('aria-pressed', segs[i] === seg ? 'true' : 'false')
        }
        segGroup.dispatchEvent(
          new CustomEvent('nc:seg', { bubbles: true, detail: { value: seg.getAttribute('data-value') } })
        )
      }
      return
    }

    var chip = e.target.closest('.chip')
    if (chip && chip.closest('[data-chips]')) {
      var group = chip.closest('[data-chips]')
      if (group.hasAttribute('data-single')) {
        var chips = group.querySelectorAll('.chip')
        for (var j = 0; j < chips.length; j++) {
          chips[j].setAttribute('aria-pressed', chips[j] === chip ? 'true' : 'false')
        }
      } else {
        chip.setAttribute('aria-pressed', chip.getAttribute('aria-pressed') === 'true' ? 'false' : 'true')
      }
      group.dispatchEvent(new CustomEvent('nc:chip', { bubbles: true, detail: { chip: chip } }))
    }
  })

  /* ---------- switches ---------- */

  document.addEventListener('click', function (e) {
    var sw = e.target.closest ? e.target.closest('[role="switch"]') : null
    if (!sw) return
    sw.setAttribute('aria-checked', sw.getAttribute('aria-checked') === 'true' ? 'false' : 'true')
  })

  /* ---------- disclosures ----------

     A [data-disc] button owns the element named by aria-controls. Used by the
     puzzle theme drawers, the openings index groups and the settings sections.
     Hidden is a real attribute here, not a class, so the content is genuinely
     out of the accessibility tree when shut. */

  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('[data-disc]') : null
    if (!btn) return
    var panel = document.getElementById(btn.getAttribute('aria-controls'))
    if (!panel) return
    var open = btn.getAttribute('aria-expanded') === 'true'
    btn.setAttribute('aria-expanded', open ? 'false' : 'true')
    panel.hidden = open
  })

  /* ---------- phone sheet ----------

     The overflow nav on narrow screens. Present on every page, so it lives
     here rather than in ten copies. */

  var sheet = document.getElementById('sheet')
  var sheetBtn = document.querySelector('[data-sheet-toggle]')
  if (sheet && sheetBtn) {
    sheet.hidden = false
    var setSheet = function (open) {
      document.body.classList.toggle('sheet-open', open)
      sheetBtn.setAttribute('aria-expanded', open ? 'true' : 'false')
    }
    sheetBtn.addEventListener('click', function () {
      setSheet(!document.body.classList.contains('sheet-open'))
    })
    var closer = document.querySelector('[data-sheet-close]')
    if (closer) {
      closer.addEventListener('click', function () {
        setSheet(false)
      })
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') setSheet(false)
    })
  }
})()
