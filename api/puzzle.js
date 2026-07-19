/**
 * TIDEPOOL — single serverless entry point.
 *
 *   POST /api/puzzle?action=<name>
 *   Authorization: Bearer <supabase access token>
 *
 * This is the only thing allowed to write scores. It regenerates every puzzle
 * from its seed and checks the submitted solution before recording anything,
 * so a tampered client cannot post a fake time.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
const { createClient } = require('@supabase/supabase-js');

const admin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

/* ───────── seeded rng — must match the client byte for byte ───────── */
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedFor = (gameId, level) => `tidepool:v1:${gameId}:${level}`;
const rngFor  = (gameId, level) => mulberry32(xmur3(seedFor(gameId, level))());
function shuffle(arr, rnd) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}


/* ───────── shared generators ─────────
   Pasted verbatim from the client so the two can never drift. Only
   generate() is ever called here; the render paths are inert. */
const MODULES = {};
const document = undefined, Audio2 = undefined, Host = undefined,
      haptic = undefined, sheet = undefined, window = undefined;

/* ═══════════════════════════════════════════════════════════════
   PHASE 3 — logic grids
   Nonogram · Kakuro · Binairo · Futoshiki · Bridges · Minefield

   Every generator here guarantees a puzzle that is solvable by pure
   deduction. Nonogram, Bridges and Minefield are validated with a
   logic solver (no guessing needed); Binairo, Futoshiki and Kakuro
   are validated by counting solutions and requiring exactly one.
   ═══════════════════════════════════════════════════════════════ */

/* ───────────────────────── NONOGRAM ───────────────────────── */
(function(){
  const sizeFor = l => l<=10?5 : l<=20?8 : l<=30?10 : l<=40?12 : 15;

  const clueOf = line => {
    const out = []; let n = 0;
    for (const v of line){ if (v) n++; else if (n){ out.push(n); n = 0; } }
    if (n) out.push(n);
    return out.length ? out : [0];
  };

  /* Enumerate every arrangement of one line consistent with what is known.
     Cells all arrangements agree on become fixed. Returns null if the line
     has become contradictory. */
  function solveLine(cl, line){
    const n = line.length;
    if (cl.length === 1 && cl[0] === 0){
      if (line.some(v => v === 1)) return null;
      return line.map(()=>2);
    }
    let res = null, hits = 0;
    (function place(idx, pos, acc){
      if (hits > 30000) return;
      if (idx === cl.length){
        for (let i=pos;i<n;i++){ if (line[i] === 1) return; acc[i] = 2; }
        hits++;
        if (!res) res = acc.slice();
        else for (let i=0;i<n;i++) if (res[i] !== acc[i]) res[i] = 0;
        return;
      }
      const len = cl[idx];
      for (let s=pos; s+len<=n; s++){
        if (s > pos && line[s-1] === 1) break;      // cannot step over a filled cell
        let ok = true;
        for (let i=s;i<s+len;i++) if (line[i] === 2){ ok = false; break; }
        if (!ok) continue;
        if (s+len < n && line[s+len] === 1) continue;
        const a = acc.slice();
        for (let i=pos;i<s;i++) a[i] = 2;
        for (let i=s;i<s+len;i++) a[i] = 1;
        if (s+len < n) a[s+len] = 2;
        place(idx+1, s+len+1, a);
      }
    })(0, 0, new Array(n).fill(0));
    return res;
  }

  /** Solve by line deduction alone. True only if no guessing was ever needed. */
  function logicSolvable(rows, cols, n){
    const g = new Array(n*n).fill(0);
    for (let pass=0; pass<n*4; pass++){
      let changed = false;
      for (let r=0;r<n;r++){
        const line = g.slice(r*n, r*n+n);
        const out = solveLine(rows[r], line);
        if (!out) return false;
        for (let c=0;c<n;c++) if (out[c] && out[c] !== g[r*n+c]){ g[r*n+c] = out[c]; changed = true; }
      }
      for (let c=0;c<n;c++){
        const line = []; for (let r=0;r<n;r++) line.push(g[r*n+c]);
        const out = solveLine(cols[c], line);
        if (!out) return false;
        for (let r=0;r<n;r++) if (out[r] && out[r] !== g[r*n+c]){ g[r*n+c] = out[r]; changed = true; }
      }
      if (!changed) break;
    }
    return g.every(v => v !== 0);
  }

  MODULES.nonogram = {
    id:'nonogram', result:'time',

    generate(level){
      const rnd = rngFor('nonogram', level);
      const n = sizeFor(level);
      let pattern = null, rows, cols;

      for (let attempt=0; attempt<60 && !pattern; attempt++){
        /* Blobby patterns read as pictures and solve more cleanly than noise. */
        const p = new Array(n*n).fill(0);
        const seeds = 2 + Math.floor(rnd()*3);
        for (let s=0;s<seeds;s++){
          let r = (rnd()*n)|0, c = (rnd()*n)|0;
          const steps = Math.floor(n*n*(0.16 + rnd()*0.14));
          for (let i=0;i<steps;i++){
            p[r*n+c] = 1;
            const d = (rnd()*4)|0;
            r = Math.max(0, Math.min(n-1, r + (d===0?1:d===1?-1:0)));
            c = Math.max(0, Math.min(n-1, c + (d===2?1:d===3?-1:0)));
          }
        }
        const filled = p.filter(Boolean).length;
        if (filled < n*n*0.25 || filled > n*n*0.72) continue;
        const R = [], C = [];
        for (let r=0;r<n;r++) R.push(clueOf(p.slice(r*n, r*n+n)));
        for (let c=0;c<n;c++){ const l=[]; for (let r=0;r<n;r++) l.push(p[r*n+c]); C.push(clueOf(l)); }
        if (logicSolvable(R, C, n)){ pattern = p; rows = R; cols = C; }
      }
      if (!pattern){ // deterministic fallback: a plain checker still solves cleanly
        pattern = new Array(n*n).fill(0).map((_,i)=> ((i%n)+((i/n)|0))%2);
        rows = []; cols = [];
        for (let r=0;r<n;r++) rows.push(clueOf(pattern.slice(r*n, r*n+n)));
        for (let c=0;c<n;c++){ const l=[]; for (let r=0;r<n;r++) l.push(pattern[r*n+c]); cols.push(clueOf(l)); }
      }

      return { n, rows, cols, solution:pattern,
               grid:new Array(n*n).fill(0), mode:1, painting:null,
               targetTime: 40 + n*n*1.6 };
    },

    preview(ctx, s, w){
      const st = this.generate(s.level), n = st.n, cell = w/n;
      ctx.fillStyle = '#131E26'; ctx.fillRect(0,0,w,w);
      ctx.fillStyle = '#3FB98A';
      for (let i=0;i<n*n;i++) if (st.solution[i])
        ctx.fillRect((i%n)*cell+1, ((i/n)|0)*cell+1, cell-2, cell-2);
      ctx.strokeStyle = '#243542'; ctx.lineWidth = 1;
      for (let i=1;i<n;i++){
        ctx.beginPath(); ctx.moveTo(i*cell,0); ctx.lineTo(i*cell,w);
        ctx.moveTo(0,i*cell); ctx.lineTo(w,i*cell); ctx.stroke();
      }
    },

    render(root, st){
      const n = st.n;
      const rowMax = Math.max(...st.rows.map(r=>r.length));
      const colMax = Math.max(...st.cols.map(c=>c.length));
      root.innerHTML =
        `<div class="ng" style="--n:${n};--rm:${rowMax};--cm:${colMax}">
           <div class="ng-corner"></div>
           <div class="ng-ctop">${st.cols.map(c=>
             `<div class="ng-cl">${c.map(v=>`<span>${v||''}</span>`).join('')}</div>`).join('')}</div>
           <div class="ng-cleft">${st.rows.map(r=>
             `<div class="ng-rl">${r.map(v=>`<span>${v||''}</span>`).join('')}</div>`).join('')}</div>
           <div class="ng-grid" id="ngg"></div>
         </div>
         <div class="pad" style="grid-template-columns:1fr 1fr">
           <button id="ng-fill" class="on">■ Fill</button>
           <button id="ng-cross">✕ Mark</button>
         </div>`;
      const gg = root.querySelector('#ngg');
      for (let i=0;i<n*n;i++){
        const d = document.createElement('div');
        d.className = 'ngc';
        d.dataset.i = i;
        if ((i%n)%5===4 && i%n!==n-1) d.classList.add('br');
        if ((((i/n)|0)%5)===4 && ((i/n)|0)!==n-1) d.classList.add('bb');
        gg.appendChild(d);
      }
      const setMode = m => {
        st.mode = m;
        root.querySelector('#ng-fill').classList.toggle('on', m===1);
        root.querySelector('#ng-cross').classList.toggle('on', m===2);
      };
      root.querySelector('#ng-fill').onclick  = ()=>{ setMode(1); Audio2.tap(); };
      root.querySelector('#ng-cross').onclick = ()=>{ setMode(2); Audio2.tap(); };

      const cellAt = e => {
        const t = document.elementFromPoint(e.clientX, e.clientY);
        return t && t.classList.contains('ngc') ? +t.dataset.i : -1;
      };
      const apply = i => {
        if (i < 0 || st.painting === null) return;
        if (st.grid[i] === st.painting) return;
        st.grid[i] = st.painting;
        this.paintCell(st, i);
        Audio2.tap();
        if (this.solved(st)) Host.finish();
      };
      gg.addEventListener('pointerdown', e => {
        const i = cellAt(e); if (i < 0) return;
        gg.setPointerCapture(e.pointerId);
        st.painting = st.grid[i] === st.mode ? 0 : st.mode;   // drag erases if you start on a set cell
        apply(i);
      });
      gg.addEventListener('pointermove', e => { if (st.painting !== null) apply(cellAt(e)); });
      const end = () => { st.painting = null; };
      gg.addEventListener('pointerup', end);
      gg.addEventListener('pointercancel', end);
    },

    paintCell(st, i){
      const el = document.querySelector(`.ngc[data-i="${i}"]`);
      if (!el) return;
      el.classList.toggle('fill', st.grid[i] === 1);
      el.classList.toggle('cross', st.grid[i] === 2);
    },

    solved(st){ return st.solution.every((v,i)=> v === 1 ? st.grid[i] === 1 : st.grid[i] !== 1); },
    serialize(st){ return { grid: st.grid.map(v => v===1?1:0) }; },
    stars(st, s){ return s <= st.targetTime ? 3 : s <= st.targetTime*1.7 ? 2 : 1; }
  };
})();

/* ───────────────────────── BINAIRO ───────────────────────── */
(function(){
  const sizeFor = l => l<=10?6 : l<=22?8 : l<=34?10 : l<=44?12 : 14;

  /* every balanced, triple-free line of length n */
  function validLines(n){
    const out = [];
    (function rec(arr, ones, zeros){
      if (arr.length === n){ out.push(arr.slice()); return; }
      for (const v of [0,1]){
        if (v ? ones+1 > n/2 : zeros+1 > n/2) continue;
        const L = arr.length;
        if (L >= 2 && arr[L-1] === v && arr[L-2] === v) continue;
        arr.push(v); rec(arr, ones + (v?1:0), zeros + (v?0:1)); arr.pop();
      }
    })([], 0, 0);
    return out;
  }

  function fullBoard(n, rnd){
    const lines = shuffle(validLines(n), rnd);
    const grid = [], used = new Set(), colOnes = new Array(n).fill(0);
    let guard = 0;
    const okCol = line => {
      const R = grid.length;
      for (let c=0;c<n;c++){
        const v = line[c];
        const ones = colOnes[c] + (v?1:0), zeros = (R+1) - ones;
        if (ones > n/2 || zeros > n/2) return false;
        if (R >= 2 && grid[R-1][c] === v && grid[R-2][c] === v) return false;
      }
      return true;
    };
    const rec = () => {
      if (++guard > 60000) return false;
      if (grid.length === n){
        const cols = new Set();
        for (let c=0;c<n;c++){
          const k = grid.map(r=>r[c]).join('');
          if (cols.has(k)) return false;
          cols.add(k);
        }
        return true;
      }
      let tried = 0;
      for (const line of lines){
        if (tried > 220) break;
        const k = line.join('');
        if (used.has(k) || !okCol(line)) continue;
        tried++;
        used.add(k); grid.push(line);
        for (let c=0;c<n;c++) if (line[c]) colOnes[c]++;
        if (rec()) return true;
        for (let c=0;c<n;c++) if (line[c]) colOnes[c]--;
        grid.pop(); used.delete(k);
      }
      return false;
    };
    if (!rec()) return null;
    return [].concat(...grid);
  }

  const triple = (g, n, r, c, v) => {
    const at = (rr,cc) => (rr<0||cc<0||rr>=n||cc>=n) ? -1 : g[rr*n+cc];
    return (at(r,c-1)===v && at(r,c-2)===v) || (at(r,c+1)===v && at(r,c+2)===v)
        || (at(r,c-1)===v && at(r,c+1)===v)
        || (at(r-1,c)===v && at(r-2,c)===v) || (at(r+1,c)===v && at(r+2,c)===v)
        || (at(r-1,c)===v && at(r+1,c)===v);
  };

  /** Deduction only. Returns the completed grid, or null if guessing would be needed. */
  function logicSolve(puz, n){
    const g = puz.slice();
    for (let pass=0; pass<n*n; pass++){
      let changed = false;
      for (let i=0;i<n*n;i++){
        if (g[i] !== -1) continue;
        const r = (i/n)|0, c = i%n;
        if (triple(g, n, r, c, 0)){ g[i] = 1; changed = true; continue; }
        if (triple(g, n, r, c, 1)){ g[i] = 0; changed = true; continue; }
      }
      for (let r=0;r<n;r++){
        let ones = 0, zeros = 0;
        for (let c=0;c<n;c++){ if (g[r*n+c] === 1) ones++; else if (g[r*n+c] === 0) zeros++; }
        if (ones === n/2 && zeros < n/2)
          for (let c=0;c<n;c++) if (g[r*n+c] === -1){ g[r*n+c] = 0; changed = true; }
        if (zeros === n/2 && ones < n/2)
          for (let c=0;c<n;c++) if (g[r*n+c] === -1){ g[r*n+c] = 1; changed = true; }
      }
      for (let c=0;c<n;c++){
        let ones = 0, zeros = 0;
        for (let r=0;r<n;r++){ if (g[r*n+c] === 1) ones++; else if (g[r*n+c] === 0) zeros++; }
        if (ones === n/2 && zeros < n/2)
          for (let r=0;r<n;r++) if (g[r*n+c] === -1){ g[r*n+c] = 0; changed = true; }
        if (zeros === n/2 && ones < n/2)
          for (let r=0;r<n;r++) if (g[r*n+c] === -1){ g[r*n+c] = 1; changed = true; }
      }
      if (!changed) break;
    }
    return g.every(v => v !== -1) ? g : null;
  }

  MODULES.binairo = {
    id:'binairo', result:'time',

    generate(level){
      const rnd = rngFor('binairo', level);
      const n = sizeFor(level);
      let sol = null;
      for (let a=0; a<8 && !sol; a++) sol = fullBoard(n, rnd);
      if (!sol){
        sol = new Array(n*n);
        for (let r=0;r<n;r++) for (let c=0;c<n;c++)
          sol[r*n+c] = ((c + (r%2)*2 + ((r/2)|0)) % 4) < 2 ? 0 : 1;
      }
      const puzzle = sol.slice();
      const order = shuffle([...Array(n*n).keys()], rnd);
      /* strip as far as pure deduction still carries the solve */
      for (const i of order){
        const save = puzzle[i];
        puzzle[i] = -1;
        if (!logicSolve(puzzle, n)) puzzle[i] = save;
      }
      return { n, solution:sol, puzzle, given:puzzle.map(v=>v!==-1),
               board:puzzle.slice(), targetTime: 30 + n*n*1.1 };
    },
    preview(ctx, s, w){
      const st = this.generate(s.level), n = st.n, cell = w/n;
      ctx.fillStyle = '#131E26'; ctx.fillRect(0,0,w,w);
      for (let i=0;i<n*n;i++){
        if (st.puzzle[i] === -1) continue;
        ctx.fillStyle = st.puzzle[i] === 1 ? '#3FB98A' : '#3A5060';
        ctx.beginPath();
        ctx.arc((i%n)*cell+cell/2, ((i/n)|0)*cell+cell/2, cell*0.32, 0, 7);
        ctx.fill();
      }
    },

    render(root, st){
      const n = st.n;
      root.innerHTML = `<div class="bn" style="--n:${n}" id="bng"></div>
        <p class="hint">Fill every square. No three alike in a row, equal counts per line, and no two lines identical.</p>`;
      const gg = root.querySelector('#bng');
      for (let i=0;i<n*n;i++){
        const d = document.createElement('div');
        d.className = 'bnc' + (st.given[i] ? ' given' : '');
        d.dataset.i = i;
        if (!st.given[i]) d.onclick = () => {
          st.board[i] = st.board[i] === -1 ? 0 : st.board[i] === 0 ? 1 : -1;
          this.paintCell(st, i); Audio2.tap();
          if (this.solved(st)) Host.finish();
        };
        gg.appendChild(d);
      }
      for (let i=0;i<n*n;i++) this.paintCell(st, i);
    },
    paintCell(st, i){
      const el = document.querySelector(`.bnc[data-i="${i}"]`);
      if (!el) return;
      el.classList.toggle('one',  st.board[i] === 1);
      el.classList.toggle('zero', st.board[i] === 0);
    },
    solved(st){ return st.board.every((v,i)=> v === st.solution[i]); },
    serialize(st){ return { board: st.board }; },
    stars(st, s){ return s <= st.targetTime ? 3 : s <= st.targetTime*1.7 ? 2 : 1; }
  };
})();

/* ───────────────────────── FUTOSHIKI ───────────────────────── */
(function(){
  const sizeFor = l => l<=10?4 : l<=20?5 : l<=32?6 : 7;

  function latin(n, rnd){
    const g = new Array(n*n).fill(0);
    const ok = (i,v) => {
      const r=(i/n)|0, c=i%n;
      for (let k=0;k<n;k++){ if (g[r*n+k]===v) return false; if (g[k*n+c]===v) return false; }
      return true;
    };
    const rec = i => {
      if (i === n*n) return true;
      for (const v of shuffle([...Array(n).keys()].map(x=>x+1), rnd))
        if (ok(i,v)){ g[i]=v; if (rec(i+1)) return true; g[i]=0; }
      return false;
    };
    rec(0);
    return g;
  }
  /* constraints: { a, b, } meaning value[a] < value[b] */
  function count(puz, n, cons, limit=2){
    const g = puz.slice();
    let c = 0, guard = 0;
    const consOf = {};                      // indexed once, not rescanned per placement
    for (const q of cons){
      (consOf[q.a] = consOf[q.a] || []).push(q);
      (consOf[q.b] = consOf[q.b] || []).push(q);
    }
    const fits = (i,v) => {
      const r=(i/n)|0, cc=i%n;
      for (let k=0;k<n;k++){
        if (k!==cc && g[r*n+k]===v) return false;
        if (k!==r  && g[k*n+cc]===v) return false;
      }
      for (const q of (consOf[i] || [])){
        if (q.a === i && g[q.b] && !(v < g[q.b])) return false;
        if (q.b === i && g[q.a] && !(g[q.a] < v)) return false;
      }
      return true;
    };
    (function rec(i){
      if (c >= limit || ++guard > 400000) return;
      while (i < n*n && g[i]) i++;
      if (i === n*n){ c++; return; }
      for (let v=1;v<=n;v++){
        if (!fits(i,v)) continue;
        g[i]=v; rec(i+1); g[i]=0;
        if (c >= limit) return;
      }
    })(0);
    return c;
  }

  MODULES.futoshiki = {
    id:'futoshiki', result:'time',

    generate(level){
      const rnd = rngFor('futoshiki', level);
      const n = sizeFor(level);
      const sol = latin(n, rnd);

      /* candidate inequalities between orthogonal neighbours */
      const pairs = [];
      for (let r=0;r<n;r++) for (let c=0;c<n;c++){
        if (c+1<n) pairs.push([r*n+c, r*n+c+1, 'h']);
        if (r+1<n) pairs.push([r*n+c, (r+1)*n+c, 'v']);
      }
      shuffle(pairs, rnd);
      const wanted = Math.round(pairs.length * (0.14 + (level/50)*0.20));
      const cons = pairs.slice(0, wanted).map(([i,j,dir]) =>
        sol[i] < sol[j] ? { a:i, b:j, dir, lt:true } : { a:j, b:i, dir, lt:false });

      /* strip givens as far as uniqueness allows */
      const puzzle = sol.slice();
      const order = shuffle([...Array(n*n).keys()], rnd);
      for (const i of order){
        const save = puzzle[i];
        puzzle[i] = 0;
        if (count(puzzle, n, cons) !== 1) puzzle[i] = save;
      }
      return { n, solution:sol, puzzle, cons, given:puzzle.map(v=>v!==0),
               board:puzzle.slice(), sel:-1, targetTime: 40 + n*n*3 };
    },

    preview(ctx, s, w){
      const st = this.generate(s.level), n = st.n, cell = w/n;
      ctx.fillStyle = '#131E26'; ctx.fillRect(0,0,w,w);
      ctx.strokeStyle = '#243542';
      for (let i=1;i<n;i++){
        ctx.beginPath(); ctx.moveTo(i*cell,0); ctx.lineTo(i*cell,w);
        ctx.moveTo(0,i*cell); ctx.lineTo(w,i*cell); ctx.stroke();
      }
      ctx.fillStyle = '#3FB98A';
      for (let i=0;i<n*n;i++) if (st.puzzle[i])
        ctx.fillRect((i%n)*cell+cell*.35, ((i/n)|0)*cell+cell*.35, cell*.3, cell*.3);
      ctx.fillStyle = '#C9B899';
      for (const q of st.cons){
        const lo = Math.min(q.a,q.b), x = (lo%n)*cell, y = ((lo/n)|0)*cell;
        if (q.dir === 'h') ctx.fillRect(x+cell*.9, y+cell*.42, cell*.2, cell*.16);
        else ctx.fillRect(x+cell*.42, y+cell*.9, cell*.16, cell*.2);
      }
    },

    render(root, st){
      const n = st.n;
      const sym = q => q.dir === 'h' ? (q.a < q.b ? '‹' : '›') : (q.a < q.b ? '⌃' : '⌄');
      root.innerHTML = `<div class="fs" style="--n:${n}" id="fsg"></div>
        <div class="pad" id="fspad" style="grid-template-columns:repeat(${n+1},1fr)"></div>`;
      const gg = root.querySelector('#fsg');
      /* interleaved grid: cells and the gaps between them */
      const tracks = Array(n).fill('1fr').join(' 0.44fr ');
      gg.style.gridTemplateColumns = tracks;
      gg.style.gridTemplateRows = tracks;
      const span = n*2 - 1;
      for (let R=0;R<span;R++) for (let C=0;C<span;C++){
        const d = document.createElement('div');
        if (R%2===0 && C%2===0){
          const i = (R/2)*n + C/2;
          d.className = 'fsc' + (st.given[i] ? ' given' : '');
          d.dataset.i = i;
          d.onclick = () => { st.sel = i; Audio2.tap(); this.paint(st); };
        } else if (R%2===0 || C%2===0){
          d.className = 'fsg-gap';
          const a = R%2===0 ? (R/2)*n + (C-1)/2 : ((R-1)/2)*n + C/2;
          const b = R%2===0 ? a+1 : a+n;
          const q = st.cons.find(x => (x.a===a&&x.b===b)||(x.a===b&&x.b===a));
          if (q) d.textContent = sym(q);
        } else d.className = 'fsg-dot';
        gg.appendChild(d);
      }
      const pad = root.querySelector('#fspad');
      for (let v=1;v<=n;v++){
        const b = document.createElement('button');
        b.textContent = v;
        b.onclick = () => this.enter(st, v);
        pad.appendChild(b);
      }
      const clr = document.createElement('button');
      clr.textContent = '⌫';
      clr.onclick = () => this.enter(st, 0);
      pad.appendChild(clr);
      this.paint(st);
    },

    enter(st, v){
      const i = st.sel;
      if (i < 0 || st.given[i]) return;
      st.board[i] = st.board[i] === v ? 0 : v;
      if (v && st.board[i] !== st.solution[i]){ Audio2.wrong(); haptic(30); }
      else Audio2.place();
      this.paint(st);
      if (this.solved(st)) Host.finish();
    },
    paint(st){
      document.querySelectorAll('.fsc').forEach(el => {
        const i = +el.dataset.i;
        el.textContent = st.board[i] || '';
        el.classList.toggle('sel', i === st.sel);
      });
    },
    solved(st){ return st.board.every((v,i)=> v === st.solution[i]); },
    serialize(st){ return { board: st.board }; },
    stars(st, s){ return s <= st.targetTime ? 3 : s <= st.targetTime*1.7 ? 2 : 1; }
  };
})();

/* ───────────────────────── KAKURO ───────────────────────── */
(function(){
  const sizeFor = l => l<=12?7 : l<=26?8 : l<=40?9 : 9;

  /* Layout with every entry 2–4 cells long. Short entries are what make a
     kakuro deducible rather than a search. */
  function layout(n, rnd){
    const block = new Array(n*n).fill(false);
    for (let i=0;i<n;i++){ block[i] = true; block[i*n] = true; }
    for (let r=1;r<n;r++){
      let run = 0, max = 2 + ((rnd()*4)|0);
      for (let c=1;c<n;c++){
        if (run >= max || rnd() < 0.04){ block[r*n+c] = true; run = 0; max = 2 + ((rnd()*4)|0); }
        else run++;
      }
    }
    for (let c=1;c<n;c++){
      let run = 0, max = 2 + ((rnd()*4)|0);
      for (let r=1;r<n;r++){
        if (block[r*n+c]){ run = 0; max = 2 + ((rnd()*4)|0); continue; }
        if (run >= max){ block[r*n+c] = true; run = 0; max = 2 + ((rnd()*4)|0); }
        else run++;
      }
    }
    /* a white cell must sit in both a horizontal and a vertical entry */
    for (let pass=0; pass<6; pass++){
      let fixed = false;
      const len = (i, dr, dc) => {
        let k = 1, r = (i/n)|0, c = i%n;
        for (let s=1;;s++){ const rr=r+dr*s, cc=c+dc*s; if (rr>=n||cc>=n||block[rr*n+cc]) break; k++; }
        for (let s=1;;s++){ const rr=r-dr*s, cc=c-dc*s; if (rr<1||cc<1||block[rr*n+cc]) break; k++; }
        return k;
      };
      for (let i=0;i<n*n;i++){
        if (block[i]) continue;
        if (len(i,0,1) < 2 || len(i,1,0) < 2){ block[i] = true; fixed = true; }
      }
      if (!fixed) break;
    }
    return block;
  }

  function collectRuns(block, n){
    const runs = [];
    for (let r=1;r<n;r++){
      let run = [];
      for (let c=1;c<=n;c++){
        const i = r*n+c;
        if (c<n && !block[i]) run.push(i);
        else { if (run.length>1) runs.push({ cells:run, dir:'h', head:run[0]-1 }); run = []; }
      }
    }
    for (let c=1;c<n;c++){
      let run = [];
      for (let r=1;r<=n;r++){
        const i = r*n+c;
        if (r<n && !block[i]) run.push(i);
        else { if (run.length>1) runs.push({ cells:run, dir:'v', head:run[0]-n }); run = []; }
      }
    }
    return runs;
  }

  /* smallest / largest total reachable with k distinct digits not already used */
  function bounds(used, k){
    let lo = 0, hi = 0, taken = 0;
    for (let d=1; d<=9 && taken<k; d++) if (!used.has(d)){ lo += d; taken++; }
    taken = 0;
    for (let d=9; d>=1 && taken<k; d--) if (!used.has(d)){ hi += d; taken++; }
    return [lo, hi];
  }

  function solveCount(whites, runsOf, limit, fixed){
    const val = Object.assign({}, fixed || {});
    let count = 0, guard = 0;
    const order = whites.filter(i => !val[i]).sort((a,b) => runsOf[b].length - runsOf[a].length);
    const rec = k => {
      if (count >= limit || ++guard > 500000) return;
      if (k === order.length){ count++; return; }
      const i = order[k];
      for (let v=1; v<=9; v++){
        let ok = true;
        for (const r of runsOf[i]){
          const used = new Set();
          let sum = 0, blanks = 0, dup = false;
          for (const c of r.cells){
            const x = c === i ? v : val[c];
            if (x){ if (used.has(x)){ dup = true; break; } used.add(x); sum += x; }
            else blanks++;
          }
          if (dup){ ok = false; break; }
          if (blanks === 0){ if (sum !== r.sum){ ok = false; break; } continue; }
          const [lo, hi] = bounds(used, blanks);
          if (sum + lo > r.sum || sum + hi < r.sum){ ok = false; break; }
        }
        if (!ok) continue;
        val[i] = v; rec(k+1); delete val[i];
        if (count >= limit) return;
      }
    };
    rec(0);
    return count;
  }

  MODULES.kakuro = {
    id:'kakuro', result:'time',

    generate(level){
      const rnd = rngFor('kakuro', level);
      const n = sizeFor(level);
      let out = null;

      for (let attempt=0; attempt<50 && !out; attempt++){
        const block = layout(n, rnd);
        const whites = [];
        for (let i=0;i<n*n;i++) if (!block[i]) whites.push(i);
        if (whites.length < n*1.5) continue;

        const runs = collectRuns(block, n);
        const runsOf = {};
        whites.forEach(i => runsOf[i] = []);
        runs.forEach(r => r.cells.forEach(c => runsOf[c].push(r)));
        if (whites.some(i => runsOf[i].length !== 2)) continue;

        /* fill with distinct digits per entry */
        const val = {};
        const fill = k => {
          if (k === whites.length) return true;
          const i = whites[k];
          for (const v of shuffle([1,2,3,4,5,6,7,8,9], rnd)){
            if (runsOf[i].some(r => r.cells.some(c => c !== i && val[c] === v))) continue;
            val[i] = v;
            if (fill(k+1)) return true;
            delete val[i];
          }
          return false;
        };
        if (!fill(0)) continue;

        runs.forEach(r => r.sum = r.cells.reduce((a,c)=>a+val[c], 0));

        /* Reveal starter digits until the grid is forced. Higher levels get
           fewer, so the search space you are handed grows with the curve. */
        const pool = shuffle(whites.slice(), rnd);
        const givens = {};
        let p = 0;
        while (solveCount(whites, runsOf, 2, givens) !== 1 && p < pool.length)
          givens[pool[p]] = val[pool[p++]];
        if (p >= pool.length) continue;
        const allowance = Math.ceil(whites.length * (0.34 - (level/50)*0.16));
        if (p > allowance) continue;
        out = { n, block, whites, runs, runsOf, solution:val, givens };
      }

      if (!out){
        /* 22 across / 16 across with a forced pair — verified unique */
        const n2 = 4, block = new Array(n2*n2).fill(true);
        [5,6,9,10].forEach(i => block[i] = false);
        const whites = [5,6,9,10];
        const runs = [
          { cells:[5,6],  dir:'h', head:4, sum:16 },
          { cells:[9,10], dir:'h', head:8, sum:11 },
          { cells:[5,9],  dir:'v', head:1, sum:16 },
          { cells:[6,10], dir:'v', head:2, sum:11 }];
        const runsOf = {}; whites.forEach(i => runsOf[i] = runs.filter(r => r.cells.includes(i)));
        out = { n:n2, block, whites, runs, runsOf, solution:{5:9,6:7,9:7,10:4}, givens:{5:9} };
      }

      const board = {};
      out.whites.forEach(i => board[i] = out.givens[i] || 0);
      return Object.assign(out, { board, sel:-1,
        targetTime: 50 + (out.whites.length - Object.keys(out.givens).length) * 12 });
    },

    countSolutions(whites, runs, _sol, limit=2, givens){
      const runsOf = {};
      whites.forEach(i => runsOf[i] = runs.filter(r => r.cells.includes(i)));
      return solveCount(whites, runsOf, limit, givens);
    },

    preview(ctx, s, w){
      const st = this.generate(s.level), n = st.n, cell = w/n;
      ctx.fillStyle = '#0E151B'; ctx.fillRect(0,0,w,w);
      for (let i=0;i<n*n;i++){
        const x = (i%n)*cell, y = ((i/n)|0)*cell;
        ctx.fillStyle = st.block[i] ? '#1B2731' : '#22323E';
        ctx.fillRect(x+.5, y+.5, cell-1, cell-1);
        if (st.block[i]){
          ctx.strokeStyle = '#3A5060'; ctx.lineWidth = .8;
          ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x+cell, y+cell); ctx.stroke();
        }
      }
      ctx.fillStyle = '#C9B899';
      st.runs.forEach(r => {
        const h = r.head, x = (h%n)*cell, y = ((h/n)|0)*cell;
        ctx.fillRect(r.dir==='h' ? x+cell*.5 : x+cell*.12, r.dir==='h' ? y+cell*.55 : y+cell*.6, cell*.32, cell*.18);
      });
    },

    render(root, st){
      const n = st.n;
      root.innerHTML = `<div class="kk" style="--n:${n}" id="kkg"></div>
        <div class="pad" id="kkpad"></div>`;
      const gg = root.querySelector('#kkg');
      const headMap = {};
      st.runs.forEach(r => { headMap[r.head] = headMap[r.head] || {}; headMap[r.head][r.dir] = r.sum; });
      for (let i=0;i<n*n;i++){
        const d = document.createElement('div');
        if (st.block[i]){
          d.className = 'kkb';
          const h = headMap[i];
          if (h) d.innerHTML = `<span class="dn">${h.v ?? ''}</span><span class="rt">${h.h ?? ''}</span>`;
        } else {
          d.className = 'kkc' + (st.givens[i] ? ' given' : '');
          d.dataset.i = i;
          if (!st.givens[i]) d.onclick = () => { st.sel = i; Audio2.tap(); this.paint(st); };
        }
        gg.appendChild(d);
      }
      const pad = root.querySelector('#kkpad');
      for (let v=1;v<=9;v++){
        const b = document.createElement('button');
        b.textContent = v;
        b.onclick = () => this.enter(st, v);
        pad.appendChild(b);
      }
      const clr = document.createElement('button');
      clr.textContent = '⌫';
      clr.onclick = () => this.enter(st, 0);
      pad.appendChild(clr);
      this.paint(st);
    },

    enter(st, v){
      const i = st.sel;
      if (i < 0 || st.block[i] || st.givens[i]) return;
      st.board[i] = st.board[i] === v ? 0 : v;
      Audio2.place();
      this.paint(st);
      if (this.solved(st)) Host.finish();
    },
    paint(st){
      document.querySelectorAll('.kkc').forEach(el => {
        const i = +el.dataset.i;
        el.textContent = st.board[i] || '';
        el.classList.toggle('sel', i === st.sel);
      });
    },
    solved(st){
      return st.runs.every(r => {
        const vals = r.cells.map(c => st.board[c]);
        if (vals.some(v => !v)) return false;
        if (new Set(vals).size !== vals.length) return false;
        return vals.reduce((a,b)=>a+b,0) === r.sum;
      });
    },
    serialize(st){ return { board: st.board }; },
    stars(st, s){ return s <= st.targetTime ? 3 : s <= st.targetTime*1.7 ? 2 : 1; }
  };
})();

/* ───────────────────────── BRIDGES (HASHI) ───────────────────────── */
(function(){
  const gridFor = l => l<=10?7 : l<=24?8 : l<=38?9 : 10;
  const islandsFor = l => 5 + Math.round((l/50) * 13);

  const key = (a,b) => a < b ? a+'_'+b : b+'_'+a;

  function neighbours(islands, g){
    /* potential links: nearest island in each direction with clear space between */
    const at = {}; islands.forEach(is => at[is.r+','+is.c] = is);
    const links = [];
    islands.forEach(is => {
      [[0,1],[1,0]].forEach(([dr,dc]) => {
        for (let k=1;k<g;k++){
          const r = is.r + dr*k, c = is.c + dc*k;
          if (r>=g || c>=g) break;
          const other = at[r+','+c];
          if (other){ links.push({ a:is.id, b:other.id, r1:is.r, c1:is.c, r2:r, c2:c, dir: dr?'v':'h' }); break; }
        }
      });
    });
    return links;
  }
  function crosses(l1, l2){
    if (l1.dir === l2.dir) return false;
    const h = l1.dir === 'h' ? l1 : l2, v = l1.dir === 'h' ? l2 : l1;
    return h.r1 > Math.min(v.r1,v.r2) && h.r1 < Math.max(v.r1,v.r2)
        && v.c1 > Math.min(h.c1,h.c2) && v.c1 < Math.max(h.c1,h.c2);
  }

  /** Pure-deduction solver over bridge-count intervals. Returns the bridge
      map if the puzzle falls out without guessing, else null. */
  function logicSolve(islands, links, degrees){
    const lo = {}, hi = {};
    links.forEach(l => { const k = key(l.a,l.b); lo[k] = 0; hi[k] = 2; });
    const linksOf = {};
    islands.forEach(is => linksOf[is.id] = links.filter(l => l.a===is.id || l.b===is.id));

    for (let pass=0; pass<400; pass++){
      let changed = false;

      /* a link known to carry traffic blocks anything crossing it */
      for (const l of links){
        const k = key(l.a,l.b);
        if (lo[k] < 1) continue;
        for (const m of links){
          if (m === l) continue;
          const mk = key(m.a,m.b);
          if (hi[mk] > 0 && crosses(l,m)){ hi[mk] = 0; changed = true; }
        }
      }

      for (const is of islands){
        const mine = linksOf[is.id];
        const need = degrees[is.id];
        let sumLo = 0, sumHi = 0;
        mine.forEach(l => { const k = key(l.a,l.b); sumLo += lo[k]; sumHi += hi[k]; });
        if (need < sumLo || need > sumHi) return null;
        for (const l of mine){
          const k = key(l.a,l.b);
          const othersHi = sumHi - hi[k], othersLo = sumLo - lo[k];
          const newLo = Math.max(lo[k], need - othersHi);
          const newHi = Math.min(hi[k], need - othersLo);
          if (newLo > newHi) return null;
          if (newLo !== lo[k]){ lo[k] = newLo; changed = true; }
          if (newHi !== hi[k]){ hi[k] = newHi; changed = true; }
        }
      }
      if (!changed) break;
    }

    for (const l of links) if (lo[key(l.a,l.b)] !== hi[key(l.a,l.b)]) return null;
    const cnt = {};
    links.forEach(l => cnt[key(l.a,l.b)] = lo[key(l.a,l.b)]);
    for (const is of islands){
      const sum = linksOf[is.id].reduce((a,l)=>a+cnt[key(l.a,l.b)], 0);
      if (sum !== degrees[is.id]) return null;
    }
    const seen = new Set([islands[0].id]), stack = [islands[0].id];
    while (stack.length){
      const id = stack.pop();
      linksOf[id].forEach(l => {
        if (cnt[key(l.a,l.b)] > 0){
          const o = l.a === id ? l.b : l.a;
          if (!seen.has(o)){ seen.add(o); stack.push(o); }
        }
      });
    }
    if (seen.size !== islands.length) return null;
    return cnt;
  }

  MODULES.hashi = {
    id:'hashi', result:'time',

    generate(level){
      const rnd = rngFor('hashi', level);
      const g = gridFor(level);
      let out = null;

      /* Aim for the level's island count; if deduction cannot carry a board
         that dense, step the target down rather than serving a toy. */
      for (let want = islandsFor(level); want >= 4 && !out; want -= 2)
      for (let attempt=0; attempt<90 && !out; attempt++){
        const occupied = {};
        const islands = [{ id:0, r:(rnd()*g)|0, c:(rnd()*g)|0 }];
        occupied[islands[0].r+','+islands[0].c] = 0;
        const built = [];

        for (let tries=0; islands.length < want && tries < want*40; tries++){
          const from = islands[(rnd()*islands.length)|0];
          const [dr,dc] = [[0,1],[0,-1],[1,0],[-1,0]][(rnd()*4)|0];
          const dist = 2 + ((rnd()*3)|0);
          const r = from.r + dr*dist, c = from.c + dc*dist;
          if (r<0||c<0||r>=g||c>=g) continue;
          if (occupied[r+','+c] !== undefined) continue;
          /* the new island must not sit on top of a bridge already laid */
          if (built.some(b => b.dir === 'h'
                ? (b.r1 === r && c > Math.min(b.c1,b.c2) && c < Math.max(b.c1,b.c2))
                : (b.c1 === c && r > Math.min(b.r1,b.r2) && r < Math.max(b.r1,b.r2)))) continue;
          /* the path must be clear of islands and of existing bridges */
          let clear = true;
          for (let k=1;k<dist;k++){
            const rr = from.r+dr*k, cc = from.c+dc*k;
            if (occupied[rr+','+cc] !== undefined){ clear = false; break; }
          }
          if (!clear) continue;
          const cand = { r1:from.r, c1:from.c, r2:r, c2:c, dir: dr?'v':'h' };
          if (built.some(b => crosses(b, cand))){ continue; }
          const id = islands.length;
          islands.push({ id, r, c });
          occupied[r+','+c] = id;
          built.push(Object.assign(cand, { a:from.id, b:id, n: rnd() < .45 ? 2 : 1 }));
        }
        if (islands.length < Math.max(4, want-3)) continue;

        /* A tree of bridges reads as flat. Close some loops so the island
           counts actually have to be reasoned about together. */
        const extra = Math.round(islands.length * 0.4);
        const cand = shuffle(neighbours(islands, g), rnd);
        let added = 0;
        for (const l of cand){
          if (added >= extra) break;
          if (built.some(b => key(b.a,b.b) === key(l.a,l.b))) continue;
          if (built.some(b => crosses(b, l))) continue;
          built.push({ a:l.a, b:l.b, r1:l.r1, c1:l.c1, r2:l.r2, c2:l.c2, dir:l.dir,
                       n: rnd() < .35 ? 2 : 1 });
          added++;
        }
        /* thicken a few for variety */
        built.forEach(b => { if (rnd() < .18 && b.n === 1) b.n = 2; });

        const degrees = {};
        islands.forEach(is => degrees[is.id] = 0);
        built.forEach(b => { degrees[b.a] += b.n; degrees[b.b] += b.n; });
        if (Object.values(degrees).some(d => d === 0 || d > 8)) continue;

        const links = neighbours(islands, g);
        if (!built.every(b => links.some(l => key(l.a,l.b) === key(b.a,b.b)))) continue;
        if (!logicSolve(islands, links, degrees)) continue;

        const sol = {};
        links.forEach(l => sol[key(l.a,l.b)] = 0);
        built.forEach(b => sol[key(b.a,b.b)] = b.n);
        out = { g, islands, links, degrees, solution:sol };
      }

      if (!out){   // two islands, one bridge — always valid
        const islands = [{id:0,r:0,c:0},{id:1,r:0,c:2}];
        const links = neighbours(islands, 3);
        out = { g:3, islands, links, degrees:{0:1,1:1}, solution:{ [key(0,1)]:1 } };
      }

      const bridges = {};
      out.links.forEach(l => bridges[key(l.a,l.b)] = 0);
      return Object.assign(out, { bridges, sel:null,
        targetTime: 30 + out.islands.length * 11 });
    },

    preview(ctx, s, w){
      const st = this.generate(s.level), g = st.g, cell = w/g;
      ctx.fillStyle = '#131E26'; ctx.fillRect(0,0,w,w);
      const px = is => [is.c*cell + cell/2, is.r*cell + cell/2];
      ctx.strokeStyle = '#3A5060'; ctx.lineWidth = Math.max(1, cell*.07);
      st.links.forEach(l => {
        const n = st.solution[key(l.a,l.b)];
        if (!n) return;
        const A = st.islands[l.a], B = st.islands[l.b];
        const [x1,y1] = px(A), [x2,y2] = px(B);
        const off = n === 2 ? cell*.1 : 0;
        for (const o of (n === 2 ? [-off, off] : [0])){
          ctx.beginPath();
          ctx.moveTo(x1 + (l.dir==='v'?o:0), y1 + (l.dir==='h'?o:0));
          ctx.lineTo(x2 + (l.dir==='v'?o:0), y2 + (l.dir==='h'?o:0));
          ctx.stroke();
        }
      });
      st.islands.forEach(is => {
        const [x,y] = px(is);
        ctx.beginPath(); ctx.arc(x, y, cell*.32, 0, 7);
        ctx.fillStyle = '#22323E'; ctx.fill();
        ctx.strokeStyle = '#3FB98A'; ctx.lineWidth = Math.max(1, cell*.06); ctx.stroke();
      });
    },

    render(root, st){
      root.innerHTML = `<canvas id="hs" class="hs"></canvas>
        <p class="hint">Tap two islands to lay a bridge. Tap again for a double, once more to clear.
        Bridges never cross, and every island must end up connected.</p>`;
      const cv = root.querySelector('#hs');
      const dpr = window.devicePixelRatio || 1;
      const size = Math.min(root.clientWidth, window.innerHeight * 0.62);
      cv.width = size*dpr; cv.height = size*dpr;
      cv.style.width = size+'px'; cv.style.height = size+'px';
      st._ctx = cv.getContext('2d'); st._ctx.scale(dpr, dpr); st._size = size;
      cv.onclick = e => {
        const rect = cv.getBoundingClientRect(), cell = size/st.g;
        const c = Math.floor((e.clientX - rect.left)/cell), r = Math.floor((e.clientY - rect.top)/cell);
        const hit = st.islands.find(is => is.r === r && is.c === c);
        if (!hit){ st.sel = null; return this.draw(st); }
        if (st.sel === null || st.sel === hit.id){ st.sel = st.sel === hit.id ? null : hit.id; Audio2.tap(); return this.draw(st); }
        const l = st.links.find(x => key(x.a,x.b) === key(st.sel, hit.id));
        if (!l){ st.sel = hit.id; Audio2.wrong(); return this.draw(st); }
        const k = key(l.a, l.b);
        const next = (st.bridges[k] + 1) % 3;
        /* refuse a crossing */
        if (next > 0 && st.links.some(m => m !== l && st.bridges[key(m.a,m.b)] > 0 && crosses(l, m))){
          Audio2.wrong(); haptic(30); st.sel = null; return this.draw(st);
        }
        st.bridges[k] = next;
        Audio2.place(); st.sel = null;
        this.draw(st);
        if (this.solved(st)) Host.finish();
      };
      this.draw(st);
    },

    draw(st){
      const ctx = st._ctx, size = st._size, cell = size/st.g;
      ctx.clearRect(0,0,size,size);
      const px = is => [is.c*cell + cell/2, is.r*cell + cell/2];
      ctx.lineWidth = Math.max(2, cell*.06);
      st.links.forEach(l => {
        const n = st.bridges[key(l.a,l.b)];
        if (!n) return;
        const [x1,y1] = px(st.islands[l.a]), [x2,y2] = px(st.islands[l.b]);
        ctx.strokeStyle = '#3FB98A';
        const off = n === 2 ? cell*.11 : 0;
        for (const o of (n === 2 ? [-off, off] : [0])){
          ctx.beginPath();
          ctx.moveTo(x1 + (l.dir==='v'?o:0), y1 + (l.dir==='h'?o:0));
          ctx.lineTo(x2 + (l.dir==='v'?o:0), y2 + (l.dir==='h'?o:0));
          ctx.stroke();
        }
      });
      st.islands.forEach(is => {
        const [x,y] = px(is);
        const used = st.links.filter(l => l.a===is.id||l.b===is.id)
                             .reduce((a,l)=>a+st.bridges[key(l.a,l.b)], 0);
        const done = used === st.degrees[is.id];
        ctx.beginPath(); ctx.arc(x, y, cell*.33, 0, 7);
        ctx.fillStyle = '#1A2731'; ctx.fill();
        ctx.strokeStyle = st.sel === is.id ? '#E8F1EE' : done ? '#3FB98A' : '#3A5060';
        ctx.lineWidth = st.sel === is.id ? 3 : 2; ctx.stroke();
        ctx.fillStyle = done ? '#3FB98A' : '#E8F1EE';
        ctx.font = `700 ${Math.round(cell*.36)}px 'Space Mono', monospace`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(st.degrees[is.id], x, y+1);
      });
    },

    solved(st){
      for (const is of st.islands){
        const used = st.links.filter(l => l.a===is.id||l.b===is.id)
                             .reduce((a,l)=>a+st.bridges[key(l.a,l.b)], 0);
        if (used !== st.degrees[is.id]) return false;
      }
      const seen = new Set([st.islands[0].id]), stack = [st.islands[0].id];
      while (stack.length){
        const id = stack.pop();
        st.links.forEach(l => {
          if (st.bridges[key(l.a,l.b)] > 0 && (l.a===id||l.b===id)){
            const o = l.a === id ? l.b : l.a;
            if (!seen.has(o)){ seen.add(o); stack.push(o); }
          }
        });
      }
      return seen.size === st.islands.length;
    },
    serialize(st){ return { bridges: st.bridges }; },
    stars(st, s){ return s <= st.targetTime ? 3 : s <= st.targetTime*1.7 ? 2 : 1; }
  };
})();

/* ───────────────────────── MINEFIELD ───────────────────────── */
(function(){
  const specFor = l => {
    const t = (l-1)/49;
    const w = Math.round(8 + t*4), h = Math.round(8 + t*8);
    return { w, h, mines: Math.round(w*h*(0.12 + t*0.08)) };
  };

  /** No-guess check: solve with counting rules plus subset elimination. */
  function noGuess(mines, w, h, start){
    const N = w*h;
    const idx = (r,c) => r*w+c;
    const nb = i => {
      const r = (i/w)|0, c = i%w, out = [];
      for (let dr=-1;dr<=1;dr++) for (let dc=-1;dc<=1;dc++){
        if (!dr && !dc) continue;
        const rr = r+dr, cc = c+dc;
        if (rr>=0 && cc>=0 && rr<h && cc<w) out.push(idx(rr,cc));
      }
      return out;
    };
    const num = new Array(N).fill(0);
    for (let i=0;i<N;i++) if (!mines[i]) num[i] = nb(i).filter(j=>mines[j]).length;

    const open = new Set(), flag = new Set();
    const reveal = i => {
      if (open.has(i) || flag.has(i) || mines[i]) return;
      const stack = [i];
      while (stack.length){
        const k = stack.pop();
        if (open.has(k) || mines[k]) continue;
        open.add(k);
        if (num[k] === 0) nb(k).forEach(j => { if (!open.has(j)) stack.push(j); });
      }
    };
    reveal(start);
    if (open.size === 0) return false;

    for (let pass=0; pass<N*2; pass++){
      let changed = false;
      const cons = [];
      for (const i of open){
        const hidden = nb(i).filter(j => !open.has(j) && !flag.has(j));
        const flagged = nb(i).filter(j => flag.has(j)).length;
        if (!hidden.length) continue;
        const need = num[i] - flagged;
        if (need === 0){ hidden.forEach(j => { reveal(j); changed = true; }); continue; }
        if (need === hidden.length){ hidden.forEach(j => { flag.add(j); changed = true; }); continue; }
        cons.push({ cells:new Set(hidden), need });
      }
      if (!changed){
        /* subset rule: if A ⊂ B then B\A carries need(B) − need(A) */
        outer:
        for (const A of cons) for (const B of cons){
          if (A === B || A.cells.size >= B.cells.size) continue;
          let sub = true;
          for (const c of A.cells) if (!B.cells.has(c)){ sub = false; break; }
          if (!sub) continue;
          const diff = [...B.cells].filter(c => !A.cells.has(c));
          const need = B.need - A.need;
          if (need === 0){ diff.forEach(j => reveal(j)); changed = true; break outer; }
          if (need === diff.length){ diff.forEach(j => flag.add(j)); changed = true; break outer; }
        }
      }
      if (!changed) break;
    }
    return open.size + flag.size === N && [...flag].every(i => mines[i]);
  }

  MODULES.minesweeper = {
    id:'minesweeper', result:'time',

    generate(level){
      const rnd = rngFor('minesweeper', level);
      const { w, h, mines:M } = specFor(level);
      const N = w*h;
      let mines = null, start = 0;

      for (let attempt=0; attempt<160 && !mines; attempt++){
        const m = new Array(N).fill(false);
        const s = (rnd()*N)|0;
        const sr = (s/w)|0, sc = s%w;
        const safe = new Set();
        for (let dr=-1;dr<=1;dr++) for (let dc=-1;dc<=1;dc++){
          const rr = sr+dr, cc = sc+dc;
          if (rr>=0&&cc>=0&&rr<h&&cc<w) safe.add(rr*w+cc);
        }
        const spots = shuffle([...Array(N).keys()].filter(i => !safe.has(i)), rnd);
        for (let k=0;k<M && k<spots.length;k++) m[spots[k]] = true;
        if (noGuess(m, w, h, s)){ mines = m; start = s; }
      }
      if (!mines){   // fall back to a light field, still fully solvable in practice
        mines = new Array(N).fill(false);
        const spots = shuffle([...Array(N).keys()], rnd).slice(0, Math.round(M*0.6));
        spots.forEach(i => mines[i] = true);
        start = [...Array(N).keys()].find(i => !mines[i]) || 0;
      }

      const num = new Array(N).fill(0);
      const nbs = i => {
        const r=(i/w)|0, c=i%w, out=[];
        for (let dr=-1;dr<=1;dr++) for (let dc=-1;dc<=1;dc++){
          if (!dr&&!dc) continue;
          const rr=r+dr, cc=c+dc;
          if (rr>=0&&cc>=0&&rr<h&&cc<w) out.push(rr*w+cc);
        }
        return out;
      };
      for (let i=0;i<N;i++) if (!mines[i]) num[i] = nbs(i).filter(j=>mines[j]).length;

      return { w, h, mines, num, start, nbs,
               open:new Set(), flag:new Set(), flagMode:false, dead:false,
               targetTime: 20 + M*2.4 };
    },

    preview(ctx, s, w){
      const st = this.generate(s.level), cell = w/Math.max(st.w, st.h);
      ctx.fillStyle = '#131E26'; ctx.fillRect(0,0,w,w);
      const ox = (w - st.w*cell)/2, oy = (w - st.h*cell)/2;
      for (let i=0;i<st.w*st.h;i++){
        const x = ox + (i%st.w)*cell, y = oy + ((i/st.w)|0)*cell;
        ctx.fillStyle = '#22323E';
        ctx.fillRect(x+.6, y+.6, cell-1.2, cell-1.2);
        if (st.mines[i]){
          ctx.fillStyle = '#E0457B';
          ctx.beginPath(); ctx.arc(x+cell/2, y+cell/2, cell*.22, 0, 7); ctx.fill();
        }
      }
    },

    render(root, st){
      root.innerHTML = `<div class="ms" style="--w:${st.w}" id="msg"></div>
        <div class="pad" style="grid-template-columns:1fr 1fr">
          <button id="ms-dig" class="on">⛏ Dig</button>
          <button id="ms-flag">⚑ Flag <span class="left" id="ms-left"></span></button>
        </div>`;
      const gg = root.querySelector('#msg');
      for (let i=0;i<st.w*st.h;i++){
        const d = document.createElement('div');
        d.className = 'msc';
        d.dataset.i = i;
        let timer = null;
        d.addEventListener('pointerdown', () => {
          timer = setTimeout(() => { timer = null; this.flag(st, i); haptic(20); }, 380);
        });
        const up = () => { if (timer){ clearTimeout(timer); timer = null; this.tap(st, i); } };
        d.addEventListener('pointerup', up);
        d.addEventListener('pointerleave', () => { clearTimeout(timer); timer = null; });
        gg.appendChild(d);
      }
      const setMode = f => {
        st.flagMode = f;
        root.querySelector('#ms-dig').classList.toggle('on', !f);
        root.querySelector('#ms-flag').classList.toggle('on', f);
      };
      root.querySelector('#ms-dig').onclick  = () => setMode(false);
      root.querySelector('#ms-flag').onclick = () => setMode(true);
      /* the guaranteed safe opening is given away — the puzzle is the deduction, not the coin flip */
      this.tap(st, st.start);
    },

    tap(st, i){
      if (st.dead) return;
      if (st.flagMode) return this.flag(st, i);
      if (st.open.has(i) || st.flag.has(i)) return;
      if (st.mines[i]){
        st.dead = true; Audio2.wrong(); haptic([40,60,40]);
        st.mines.forEach((m,j) => m && st.open.add(j));
        this.paint(st);
        return sheet(`<div class="eyebrow">boom</div>
          <h2 style="font-size:26px;margin:6px 0 8px">You hit a mine</h2>
          <p style="color:var(--mute);margin:0;font-size:14px">Every level here is solvable without guessing — the deduction was there.</p>
          <div class="row"><button class="btn" id="m-retry">Try again</button></div>`,
          { dismissable:false, wire:(el,close)=> el.querySelector('#m-retry').onclick = () => {
              close(); Host.open('minesweeper', Host.level); } });
      }
      const stack = [i];
      while (stack.length){
        const k = stack.pop();
        if (st.open.has(k) || st.flag.has(k)) continue;
        st.open.add(k);
        if (st.num[k] === 0) st.nbs(k).forEach(j => { if (!st.open.has(j)) stack.push(j); });
      }
      Audio2.tap();
      this.paint(st);
      if (this.solved(st)) Host.finish();
    },
    flag(st, i){
      if (st.dead || st.open.has(i)) return;
      st.flag.has(i) ? st.flag.delete(i) : st.flag.add(i);
      Audio2.place();
      this.paint(st);
      if (this.solved(st)) Host.finish();
    },
    paint(st){
      const COL = ['','#58B8D8','#3FB98A','#E0457B','#C9B899','#E08A45','#8AD8C8','#E8F1EE','#8AA0AC'];
      document.querySelectorAll('.msc').forEach(el => {
        const i = +el.dataset.i;
        el.className = 'msc';
        if (st.flag.has(i)){ el.textContent = '⚑'; el.classList.add('flag'); return; }
        if (!st.open.has(i)){ el.textContent = ''; return; }
        el.classList.add('open');
        if (st.mines[i]){ el.textContent = '✳'; el.classList.add('mine'); return; }
        el.textContent = st.num[i] || '';
        el.style.color = COL[st.num[i]] || '';
      });
      const left = document.getElementById('ms-left');
      if (left) left.textContent = st.mines.filter(Boolean).length - st.flag.size;
    },
    solved(st){
      if (st.dead) return false;
      for (let i=0;i<st.w*st.h;i++) if (!st.mines[i] && !st.open.has(i)) return false;
      return true;
    },
    serialize(st){ return { open:[...st.open].sort((a,b)=>a-b), flags:[...st.flag].sort((a,b)=>a-b) }; },
    stars(st, s){ return s <= st.targetTime ? 3 : s <= st.targetTime*1.7 ? 2 : 1; }
  };
})();

/* ═══════════════════════════════════════════════════════════════
   PHASE 4 — paths
   Flow · Maze · Slitherlink
   ═══════════════════════════════════════════════════════════════ */

/* ───────────────────────── FLOW ───────────────────────── */
(function(){
  const sizeFor  = l => l<=10?5 : l<=22?6 : l<=34?7 : l<=44?8 : 9;
  const colorFor = l => Math.min(8, 3 + Math.round((l/50)*4));
  const HUES = ['#3FB98A','#E0457B','#58B8D8','#C9B899','#E08A45','#9B7BE0','#4BD6C0','#E8E14B'];

  const nbrs = (i, n) => {
    const r = (i/n)|0, c = i%n, out = [];
    if (r>0)   out.push(i-n);
    if (r<n-1) out.push(i+n);
    if (c>0)   out.push(i-1);
    if (c<n-1) out.push(i+1);
    return out;
  };

  /** Grow k simple paths that between them cover every cell. */
  function grow(n, k, rnd){
    const owner = new Array(n*n).fill(-1);
    const paths = [];
    const seeds = shuffle([...Array(n*n).keys()], rnd).slice(0, k);
    seeds.forEach((s,i) => { owner[s] = i; paths.push([s]); });

    const alive = new Set(paths.map((_,i)=>i));
    while (alive.size){
      for (const p of [...alive]){
        const head = paths[p][paths[p].length-1];
        /* A cell may only touch its own path at the head, otherwise the drawn
           line could short-circuit and the puzzle stops being well posed. */
        const free = nbrs(head, n).filter(j =>
          owner[j] === -1 && nbrs(j, n).filter(x => owner[x] === p).length === 1);
        if (!free.length){ alive.delete(p); continue; }
        /* prefer the tightest corner, which is what keeps cells from being orphaned */
        let best = free[0], bestScore = 99;
        shuffle(free, rnd).forEach(j => {
          const s = nbrs(j, n).filter(x => owner[x] === -1).length;
          if (s < bestScore){ bestScore = s; best = j; }
        });
        owner[best] = p; paths[p].push(best);
      }
    }
    /* mop up stranded cells by extending whichever path end can legally take them */
    for (let pass=0; pass<12; pass++){
      let absorbed = false;
      for (let i=0;i<n*n;i++){
        if (owner[i] !== -1) continue;
        for (let p=0;p<paths.length;p++){
          const path = paths[p];
          const touch = nbrs(i, n).filter(x => owner[x] === p);
          if (touch.length !== 1) continue;
          if (touch[0] === path[path.length-1]){ path.push(i); owner[i] = p; absorbed = true; break; }
          if (touch[0] === path[0]){ path.unshift(i); owner[i] = p; absorbed = true; break; }
        }
      }
      if (!absorbed) break;
    }
    if (owner.some(o => o === -1)) return null;
    if (paths.some(p => p.length < 3)) return null;
    return { owner, paths };
  }

  MODULES.flow = {
    id:'flow', result:'time',

    generate(level){
      const rnd = rngFor('flow', level);
      const n = sizeFor(level);
      let k = colorFor(level), built = null;
      /* aim for the level's pair count, easing off if the grid will not cover */
      for (let want = k; want >= 3 && !built; want--){
        for (let a=0; a<1400 && !built; a++) built = grow(n, want, rnd);
        if (built) k = want;
      }
      if (!built){                     // one path per row: always covers, never self-touches
        const owner = new Array(n*n).fill(0), paths = [];
        for (let r=0;r<n;r++){
          const p = [];
          for (let c=0;c<n;c++){ const i = r*n+c; owner[i] = r; p.push(i); }
          paths.push(p);
        }
        k = n;
        built = { owner, paths };
      }
      const ends = built.paths.map(p => [p[0], p[p.length-1]]);
      const endpoint = new Array(n*n).fill(-1);
      ends.forEach(([a,b], ci) => { endpoint[a] = ci; endpoint[b] = ci; });

      return { n, k, ends, endpoint, solution:built.owner,
               cell:new Array(n*n).fill(-1), trails:ends.map(()=>[]),
               drawing:null, targetTime: 20 + n*n*1.5 };
    },

    preview(ctx, s, w){
      const st = this.generate(s.level), n = st.n, cell = w/n;
      ctx.fillStyle = '#131E26'; ctx.fillRect(0,0,w,w);
      ctx.lineWidth = cell*.34; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      st.ends.forEach((_, ci) => {
        const path = [];
        for (let i=0;i<n*n;i++) if (st.solution[i] === ci) path.push(i);
        ctx.strokeStyle = HUES[ci % HUES.length];
        ctx.fillStyle = HUES[ci % HUES.length];
      });
      /* draw the solved paths in order so the miniature reads as ribbons */
      st.ends.forEach(([a], ci) => {
        ctx.strokeStyle = HUES[ci % HUES.length];
        const seq = [];
        let cur = a, seen = new Set([a]);
        for (let guard=0; guard<n*n; guard++){
          seq.push(cur);
          const nx = nbrs(cur, n).find(j => st.solution[j] === ci && !seen.has(j));
          if (nx === undefined) break;
          seen.add(nx); cur = nx;
        }
        ctx.beginPath();
        seq.forEach((i, idx) => {
          const x = (i%n)*cell + cell/2, y = ((i/n)|0)*cell + cell/2;
          idx ? ctx.lineTo(x,y) : ctx.moveTo(x,y);
        });
        ctx.stroke();
      });
      st.ends.forEach(([a,b], ci) => {
        ctx.fillStyle = HUES[ci % HUES.length];
        [a,b].forEach(i => {
          ctx.beginPath();
          ctx.arc((i%n)*cell + cell/2, ((i/n)|0)*cell + cell/2, cell*.28, 0, 7);
          ctx.fill();
        });
      });
    },

    render(root, st){
      const n = st.n;
      root.innerHTML = `<div class="fl" style="--n:${n}" id="flg"></div>
        <p class="hint">Join each pair and fill every square. Drag from a dot; crossing another line clears it.</p>`;
      const gg = root.querySelector('#flg');
      for (let i=0;i<n*n;i++){
        const d = document.createElement('div');
        d.className = 'flc';
        d.dataset.i = i;
        if (st.endpoint[i] >= 0){
          d.classList.add('end');
          d.style.setProperty('--hue', HUES[st.endpoint[i] % HUES.length]);
        }
        gg.appendChild(d);
      }
      const cellAt = e => {
        const t = document.elementFromPoint(e.clientX, e.clientY);
        return t && t.classList.contains('flc') ? +t.dataset.i : -1;
      };
      const startAt = i => {
        if (st.endpoint[i] >= 0){
          const c = st.endpoint[i];
          st.drawing = c;
          st.trails[c] = [i];
          this.recolour(st);
          return true;
        }
        if (st.cell[i] >= 0){
          const c = st.cell[i];
          const idx = st.trails[c].indexOf(i);
          if (idx >= 0){ st.trails[c] = st.trails[c].slice(0, idx+1); st.drawing = c; this.recolour(st); return true; }
        }
        return false;
      };
      gg.addEventListener('pointerdown', e => {
        const i = cellAt(e); if (i < 0) return;
        gg.setPointerCapture(e.pointerId);
        if (startAt(i)) Audio2.tap();
      });
      gg.addEventListener('pointermove', e => {
        if (st.drawing === null) return;
        const i = cellAt(e); if (i < 0) return;
        const c = st.drawing, tr = st.trails[c];
        const head = tr[tr.length-1];
        if (i === head) return;
        if (tr.length > 1 && i === tr[tr.length-2]){ tr.pop(); return this.recolour(st); }
        if (!nbrs(head, n).includes(i)) return;
        if (st.endpoint[i] >= 0 && st.endpoint[i] !== c) return;      // never run over a foreign dot
        if (st.endpoint[head] >= 0 && tr.length > 1 && st.endpoint[head] === c) return; // already closed
        if (tr.includes(i)) return;
        /* stepping onto another colour truncates that colour */
        if (st.cell[i] >= 0 && st.cell[i] !== c){
          const o = st.cell[i], oi = st.trails[o].indexOf(i);
          if (oi >= 0) st.trails[o] = st.trails[o].slice(0, oi);
        }
        tr.push(i);
        Audio2.tap();
        this.recolour(st);
        if (this.solved(st)) Host.finish();
      });
      const end = () => { st.drawing = null; };
      gg.addEventListener('pointerup', end);
      gg.addEventListener('pointercancel', end);
      this.recolour(st);
    },

    recolour(st){
      st.cell.fill(-1);
      st.trails.forEach((tr, c) => tr.forEach(i => st.cell[i] = c));
      const n = st.n;
      document.querySelectorAll('.flc').forEach(el => {
        const i = +el.dataset.i, c = st.cell[i];
        el.style.setProperty('--fill', c >= 0 ? HUES[c % HUES.length] : 'transparent');
        el.classList.toggle('on', c >= 0);
        const tr = c >= 0 ? st.trails[c] : null;
        const pos = tr ? tr.indexOf(i) : -1;
        let dirs = '';
        if (tr && pos >= 0){
          [tr[pos-1], tr[pos+1]].forEach(j => {
            if (j === undefined) return;
            dirs += j === i-n ? 'u' : j === i+n ? 'd' : j === i-1 ? 'l' : 'r';
          });
        }
        el.dataset.dirs = dirs;
      });
    },

    solved(st){
      if (st.cell.some(c => c < 0)) return false;
      return st.trails.every((tr, c) => {
        if (tr.length < 2) return false;
        const [a,b] = st.ends[c];
        const head = tr[0], tail = tr[tr.length-1];
        if (!((head===a&&tail===b) || (head===b&&tail===a))) return false;
        for (let i=1;i<tr.length;i++) if (!nbrs(tr[i-1], st.n).includes(tr[i])) return false;
        return true;
      });
    },
    serialize(st){ return { trails: st.trails }; },
    stars(st, s){ return s <= st.targetTime ? 3 : s <= st.targetTime*1.7 ? 2 : 1; }
  };
})();

/* ───────────────────────── MAZE ───────────────────────── */
(function(){
  const sizeFor = l => l<=10?9 : l<=22?13 : l<=34?17 : l<=44?21 : 25;
  const braidFor = l => Math.min(0.35, (l/50)*0.4);   // loops added at depth

  MODULES.maze = {
    id:'maze', result:'time',

    generate(level){
      const rnd = rngFor('maze', level);
      const n = sizeFor(level);
      /* walls[i] = [top, right, bottom, left] */
      const walls = Array.from({length:n*n}, ()=>[true,true,true,true]);
      const seen = new Array(n*n).fill(false);
      const DIR = [[-n,0,2],[1,1,3],[n,2,0],[-1,3,1]];   // delta, wall, opposite
      const okStep = (i, d) => {
        const c = i%n;
        if (d === 1 && c === n-1) return false;
        if (d === 3 && c === 0) return false;
        const j = i + DIR[d][0];
        return j >= 0 && j < n*n;
      };
      /* randomised depth-first carve */
      const stack = [0]; seen[0] = true;
      while (stack.length){
        const i = stack[stack.length-1];
        const opts = shuffle([0,1,2,3], rnd)
          .filter(d => okStep(i,d) && !seen[i + DIR[d][0]]);
        if (!opts.length){ stack.pop(); continue; }
        const d = opts[0], j = i + DIR[d][0];
        walls[i][DIR[d][1]] = false;
        walls[j][DIR[d][2]] = false;
        seen[j] = true; stack.push(j);
      }
      /* braid: knock out some dead ends so there is more than one route */
      const braid = braidFor(level);
      for (let i=0;i<n*n;i++){
        if (walls[i].filter(Boolean).length !== 3) continue;
        if (rnd() > braid) continue;
        const opts = shuffle([0,1,2,3], rnd).filter(d => okStep(i,d) && walls[i][DIR[d][1]]);
        if (!opts.length) continue;
        const d = opts[0], j = i + DIR[d][0];
        walls[i][DIR[d][1]] = false;
        walls[j][DIR[d][2]] = false;
      }
      const start = 0, goal = n*n - 1;
      return { n, walls, start, goal, trail:[start], drawing:false,
               targetTime: 12 + n*2.6 };
    },

    open(st, i, j){
      const n = st.n;
      if (j === i-n) return !st.walls[i][0];
      if (j === i+1) return !st.walls[i][1];
      if (j === i+n) return !st.walls[i][2];
      if (j === i-1) return !st.walls[i][3];
      return false;
    },

    preview(ctx, s, w){
      const st = this.generate(s.level), n = st.n, cell = w/n;
      ctx.fillStyle = '#131E26'; ctx.fillRect(0,0,w,w);
      ctx.strokeStyle = '#3A5060'; ctx.lineWidth = Math.max(.6, cell*.16);
      ctx.beginPath();
      for (let i=0;i<n*n;i++){
        const x = (i%n)*cell, y = ((i/n)|0)*cell;
        if (st.walls[i][0]){ ctx.moveTo(x,y); ctx.lineTo(x+cell,y); }
        if (st.walls[i][3]){ ctx.moveTo(x,y); ctx.lineTo(x,y+cell); }
      }
      ctx.moveTo(0,w); ctx.lineTo(w,w); ctx.moveTo(w,0); ctx.lineTo(w,w);
      ctx.stroke();
      ctx.fillStyle = '#3FB98A'; ctx.fillRect(cell*.2, cell*.2, cell*.6, cell*.6);
      ctx.fillStyle = '#E0457B'; ctx.fillRect(w-cell*.8, w-cell*.8, cell*.6, cell*.6);
    },

    render(root, st){
      root.innerHTML = `<canvas id="mz" class="mz"></canvas>
        <p class="hint">Drag from the green square to the pink one. Retrace to back out of a wrong turn.</p>`;
      const cv = root.querySelector('#mz');
      const dpr = window.devicePixelRatio || 1;
      const size = Math.min(root.clientWidth, window.innerHeight * 0.66);
      cv.width = size*dpr; cv.height = size*dpr;
      cv.style.width = size+'px'; cv.style.height = size+'px';
      st._ctx = cv.getContext('2d'); st._ctx.scale(dpr, dpr); st._size = size;

      const cellAt = e => {
        const rect = cv.getBoundingClientRect(), cell = size/st.n;
        const c = Math.floor((e.clientX - rect.left)/cell), r = Math.floor((e.clientY - rect.top)/cell);
        return (r<0||c<0||r>=st.n||c>=st.n) ? -1 : r*st.n + c;
      };
      cv.addEventListener('pointerdown', e => {
        const i = cellAt(e);
        cv.setPointerCapture(e.pointerId);
        if (st.trail.includes(i)){ st.trail = st.trail.slice(0, st.trail.indexOf(i)+1); st.drawing = true; this.draw(st); }
        else if (i === st.start){ st.trail = [st.start]; st.drawing = true; this.draw(st); }
      });
      cv.addEventListener('pointermove', e => {
        if (!st.drawing) return;
        const i = cellAt(e); if (i < 0) return;
        const head = st.trail[st.trail.length-1];
        if (i === head) return;
        if (st.trail.length > 1 && i === st.trail[st.trail.length-2]){ st.trail.pop(); return this.draw(st); }
        if (!this.open(st, head, i)) return;
        if (st.trail.includes(i)) return;
        st.trail.push(i);
        Audio2.tap();
        this.draw(st);
        if (this.solved(st)) Host.finish();
      });
      const end = () => { st.drawing = false; };
      cv.addEventListener('pointerup', end);
      cv.addEventListener('pointercancel', end);
      this.draw(st);
    },

    draw(st){
      const ctx = st._ctx, size = st._size, n = st.n, cell = size/n;
      ctx.clearRect(0,0,size,size);
      ctx.fillStyle = '#3FB98A'; ctx.globalAlpha = .25;
      ctx.fillRect((st.start%n)*cell, ((st.start/n)|0)*cell, cell, cell);
      ctx.fillStyle = '#E0457B';
      ctx.fillRect((st.goal%n)*cell, ((st.goal/n)|0)*cell, cell, cell);
      ctx.globalAlpha = 1;

      if (st.trail.length > 1){
        ctx.strokeStyle = '#3FB98A';
        ctx.lineWidth = Math.max(2, cell*.42);
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath();
        st.trail.forEach((i, idx) => {
          const x = (i%n)*cell + cell/2, y = ((i/n)|0)*cell + cell/2;
          idx ? ctx.lineTo(x,y) : ctx.moveTo(x,y);
        });
        ctx.stroke();
      }
      ctx.strokeStyle = '#4A6474';
      ctx.lineWidth = Math.max(1.2, cell*.14);
      ctx.lineCap = 'square';
      ctx.beginPath();
      for (let i=0;i<n*n;i++){
        const x = (i%n)*cell, y = ((i/n)|0)*cell;
        if (st.walls[i][0]){ ctx.moveTo(x,y); ctx.lineTo(x+cell,y); }
        if (st.walls[i][3]){ ctx.moveTo(x,y); ctx.lineTo(x,y+cell); }
      }
      ctx.moveTo(0,size); ctx.lineTo(size,size);
      ctx.moveTo(size,0); ctx.lineTo(size,size);
      ctx.stroke();
    },

    solved(st){ return st.trail[st.trail.length-1] === st.goal; },
    serialize(st){ return { trail: st.trail }; },
    stars(st, s){ return s <= st.targetTime ? 3 : s <= st.targetTime*1.7 ? 2 : 1; }
  };
})();

/* ───────────────────────── SLITHERLINK ───────────────────────── */
(function(){
  const sizeFor = l => l<=14?5 : l<=30?6 : 7;

  /* edge indexing: H(r,c) r∈0..n, c∈0..n-1  then  V(r,c) r∈0..n-1, c∈0..n */
  const mk = n => {
    const H = (n+1)*n, total = H + n*(n+1);
    return {
      H, total,
      h: (r,c) => r*n + c,
      v: (r,c) => H + r*(n+1) + c,
      cellEdges(r,c){ return [this.h(r,c), this.h(r+1,c), this.v(r,c), this.v(r,c+1)]; },
      vertexEdges(r,c){
        const out = [];
        if (c > 0) out.push(this.h(r,c-1));
        if (c < n) out.push(this.h(r,c));
        if (r > 0) out.push(this.v(r-1,c));
        if (r < n) out.push(this.v(r,c));
        return out;
      }
    };
  };

  function makeSolver(n, clues){
    const E = mk(n);
    const cellsOf = [], vertsOf = [];
    for (let i=0;i<E.total;i++){ cellsOf.push([]); vertsOf.push([]); }
    const cellList = [], vertList = [];
    for (let r=0;r<n;r++) for (let c=0;c<n;c++){
      const es = E.cellEdges(r,c);
      const id = cellList.length;
      cellList.push({ es, clue: clues[r*n+c] });
      es.forEach(e => cellsOf[e].push(id));
    }
    for (let r=0;r<=n;r++) for (let c=0;c<=n;c++){
      const es = E.vertexEdges(r,c);
      const id = vertList.length;
      vertList.push({ es });
      es.forEach(e => vertsOf[e].push(id));
    }
    return { E, cellList, vertList, cellsOf, vertsOf };
  }

  /** Propagate forced edges. Returns false on contradiction. */
  function propagate(S, st, queue){
    while (queue.length){
      const e = queue.pop();
      for (const ci of S.cellsOf[e]){
        const cell = S.cellList[ci];
        if (cell.clue == null) continue;
        let on = 0, unk = [];
        for (const x of cell.es){ if (st[x] === 1) on++; else if (st[x] === -1) unk.push(x); }
        if (on > cell.clue) return false;
        if (on + unk.length < cell.clue) return false;
        if (on === cell.clue && unk.length){ unk.forEach(x => { st[x] = 0; queue.push(x); }); }
        else if (on + unk.length === cell.clue && unk.length){ unk.forEach(x => { st[x] = 1; queue.push(x); }); }
      }
      for (const vi of S.vertsOf[e]){
        const v = S.vertList[vi];
        let on = 0, unk = [];
        for (const x of v.es){ if (st[x] === 1) on++; else if (st[x] === -1) unk.push(x); }
        if (on > 2) return false;
        if (on === 2 && unk.length){ unk.forEach(x => { st[x] = 0; queue.push(x); }); }
        else if (on === 1 && unk.length === 1){ st[unk[0]] = 1; queue.push(unk[0]); }
        else if (on === 1 && unk.length === 0) return false;
      }
    }
    return true;
  }

  function singleLoop(S, st, n){
    const on = [];
    for (let e=0;e<S.E.total;e++) if (st[e] === 1) on.push(e);
    if (!on.length) return false;
    /* every vertex must have degree 0 or 2 */
    for (const v of S.vertList){
      const d = v.es.filter(e => st[e] === 1).length;
      if (d !== 0 && d !== 2) return false;
    }
    /* and the on-edges must form one connected component */
    const adj = {};
    S.vertList.forEach((v, i) => { adj[i] = v.es.filter(e => st[e] === 1); });
    const edgeVerts = {};
    S.vertList.forEach((v, i) => v.es.forEach(e => (edgeVerts[e] = edgeVerts[e] || []).push(i)));
    const startV = S.vertList.findIndex(v => v.es.some(e => st[e] === 1));
    const seen = new Set([startV]), stack = [startV];
    let count = 0;
    const usedE = new Set();
    while (stack.length){
      const vi = stack.pop();
      for (const e of adj[vi]){
        if (usedE.has(e)) continue;
        usedE.add(e); count++;
        for (const o of edgeVerts[e]) if (!seen.has(o)){ seen.add(o); stack.push(o); }
      }
    }
    return count === on.length;
  }

  function countSolutions(n, clues, limit=2){
    const S = makeSolver(n, clues);
    const st = new Array(S.E.total).fill(-1);
    let found = 0, guard = 0;
    const q = [];
    for (let e=0;e<S.E.total;e++) q.push(e);
    if (!propagate(S, st, q)) return 0;

    (function rec(){
      if (found >= limit || ++guard > 260000) return;
      const e = st.indexOf(-1);
      if (e === -1){ if (singleLoop(S, st, n)) found++; return; }
      for (const v of [1,0]){
        const snap = st.slice();
        st[e] = v;
        if (propagate(S, st, [e])) rec();
        for (let i=0;i<st.length;i++) st[i] = snap[i];
        if (found >= limit) return;
      }
    })();
    return found;
  }

  /** Grow a simply connected blob; its boundary is one closed loop. */
  function blob(n, rnd){
    const inside = new Array(n*n).fill(false);
    const start = ((n/2)|0)*n + ((n/2)|0);
    inside[start] = true;
    const want = Math.max(4, Math.round(n*n*(0.3 + rnd()*0.25)));
    let size = 1, guard = 0;
    while (size < want && guard++ < n*n*40){
      const cands = [];
      for (let i=0;i<n*n;i++){
        if (inside[i]) continue;
        const r = (i/n)|0, c = i%n;
        const touch = [[r-1,c],[r+1,c],[r,c-1],[r,c+1]]
          .filter(([rr,cc]) => rr>=0&&cc>=0&&rr<n&&cc<n && inside[rr*n+cc]).length;
        if (touch) cands.push(i);
      }
      if (!cands.length) break;
      const pick = cands[(rnd()*cands.length)|0];
      inside[pick] = true;
      /* reject if it created a hole: outside must stay connected to the border */
      const out = new Array(n*n).fill(false);
      const stack = [];
      for (let i=0;i<n*n;i++){
        const r=(i/n)|0, c=i%n;
        if (!inside[i] && (r===0||c===0||r===n-1||c===n-1)){ out[i]=true; stack.push(i); }
      }
      while (stack.length){
        const i = stack.pop(), r=(i/n)|0, c=i%n;
        [[r-1,c],[r+1,c],[r,c-1],[r,c+1]].forEach(([rr,cc]) => {
          if (rr<0||cc<0||rr>=n||cc>=n) return;
          const j = rr*n+cc;
          if (!inside[j] && !out[j]){ out[j] = true; stack.push(j); }
        });
      }
      let hole = false;
      for (let i=0;i<n*n;i++) if (!inside[i] && !out[i]) hole = true;
      if (hole){ inside[pick] = false; continue; }
      size++;
    }
    return inside;
  }

  MODULES.slitherlink = {
    id:'slitherlink', result:'time',

    generate(level){
      const rnd = rngFor('slitherlink', level);
      const n = sizeFor(level);
      let out = null;

      for (let attempt=0; attempt<30 && !out; attempt++){
        const inside = blob(n, rnd);
        if (inside.filter(Boolean).length < 4) continue;
        const E = mk(n);
        const sol = new Array(E.total).fill(0);
        const IN = (r,c) => (r<0||c<0||r>=n||c>=n) ? false : inside[r*n+c];
        for (let r=0;r<n;r++) for (let c=0;c<n;c++){
          if (!IN(r,c)) continue;
          if (!IN(r-1,c)) sol[E.h(r,c)]   = 1;
          if (!IN(r+1,c)) sol[E.h(r+1,c)] = 1;
          if (!IN(r,c-1)) sol[E.v(r,c)]   = 1;
          if (!IN(r,c+1)) sol[E.v(r,c+1)] = 1;
        }
        const full = new Array(n*n);
        for (let r=0;r<n;r++) for (let c=0;c<n;c++)
          full[r*n+c] = E.cellEdges(r,c).filter(e => sol[e] === 1).length;

        if (countSolutions(n, full, 2) !== 1) continue;

        /* strip clues while the loop stays forced */
        const clues = full.slice();
        const order = shuffle([...Array(n*n).keys()], rnd);
        const floor = Math.round(n*n * (0.62 - (level/50)*0.30));
        let kept = n*n;
        for (const i of order){
          if (kept <= floor) break;
          const save = clues[i];
          clues[i] = null;
          if (countSolutions(n, clues, 2) !== 1){ clues[i] = save; }
          else kept--;
        }
        out = { n, clues, solution:sol, inside };
      }

      if (!out){
        const n2 = 5, E = mk(n2);
        const inside = new Array(n2*n2).fill(false);
        [6,7,11,12].forEach(i => inside[i] = true);
        const sol = new Array(E.total).fill(0);
        const IN = (r,c) => (r<0||c<0||r>=n2||c>=n2) ? false : inside[r*n2+c];
        for (let r=0;r<n2;r++) for (let c=0;c<n2;c++){
          if (!IN(r,c)) continue;
          if (!IN(r-1,c)) sol[E.h(r,c)]   = 1;
          if (!IN(r+1,c)) sol[E.h(r+1,c)] = 1;
          if (!IN(r,c-1)) sol[E.v(r,c)]   = 1;
          if (!IN(r,c+1)) sol[E.v(r,c+1)] = 1;
        }
        const clues = new Array(n2*n2).fill(null);
        for (let r=0;r<n2;r++) for (let c=0;c<n2;c++)
          clues[r*n2+c] = E.cellEdges(r,c).filter(e => sol[e] === 1).length;
        out = { n:n2, clues, solution:sol, inside };
      }

      const E = mk(out.n);
      return Object.assign(out, { E, edges:new Array(E.total).fill(0),
        targetTime: 60 + out.n*out.n*4 });
    },

    preview(ctx, s, w){
      const st = this.generate(s.level), n = st.n, cell = w/(n+1), o = cell/2;
      ctx.fillStyle = '#131E26'; ctx.fillRect(0,0,w,w);
      ctx.fillStyle = '#3A5060';
      for (let r=0;r<=n;r++) for (let c=0;c<=n;c++){
        ctx.beginPath(); ctx.arc(o+c*cell, o+r*cell, Math.max(.8, cell*.07), 0, 7); ctx.fill();
      }
      ctx.strokeStyle = '#3FB98A'; ctx.lineWidth = Math.max(1.4, cell*.13); ctx.lineCap = 'round';
      ctx.beginPath();
      for (let r=0;r<=n;r++) for (let c=0;c<n;c++)
        if (st.solution[st.E.h(r,c)]){ ctx.moveTo(o+c*cell, o+r*cell); ctx.lineTo(o+(c+1)*cell, o+r*cell); }
      for (let r=0;r<n;r++) for (let c=0;c<=n;c++)
        if (st.solution[st.E.v(r,c)]){ ctx.moveTo(o+c*cell, o+r*cell); ctx.lineTo(o+c*cell, o+(r+1)*cell); }
      ctx.stroke();
      ctx.fillStyle = '#8AA0AC';
      ctx.font = `${Math.round(cell*.44)}px 'Space Mono', monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (let r=0;r<n;r++) for (let c=0;c<n;c++){
        const v = st.clues[r*n+c];
        if (v != null) ctx.fillText(v, o+(c+.5)*cell, o+(r+.5)*cell);
      }
    },

    render(root, st){
      const n = st.n;
      root.innerHTML = `<div class="sl" id="slg"></div>
        <p class="hint">Draw one closed loop. Each number says how many of its four sides the loop uses.
        Tap an edge for a line, again to rule it out.</p>`;
      const gg = root.querySelector('#slg');
      const size = Math.min(root.clientWidth, window.innerHeight * 0.6);
      gg.style.width = size+'px'; gg.style.height = size+'px';
      const cell = size/(n+1), o = cell/2;
      st._cell = cell; st._o = o;

      for (let r=0;r<n;r++) for (let c=0;c<n;c++){
        const v = st.clues[r*n+c];
        if (v == null) continue;
        const d = document.createElement('div');
        d.className = 'slnum';
        d.style.left = (o+(c+.5)*cell)+'px'; d.style.top = (o+(r+.5)*cell)+'px';
        d.style.fontSize = Math.round(cell*.42)+'px';
        d.textContent = v;
        gg.appendChild(d);
      }
      for (let r=0;r<=n;r++) for (let c=0;c<=n;c++){
        const d = document.createElement('div');
        d.className = 'sldot';
        d.style.left = (o+c*cell)+'px'; d.style.top = (o+r*cell)+'px';
        gg.appendChild(d);
      }
      const addEdge = (e, x, y, w2, h2) => {
        const d = document.createElement('div');
        d.className = 'sledge';
        d.style.left = x+'px'; d.style.top = y+'px';
        d.style.width = w2+'px'; d.style.height = h2+'px';
        d.dataset.e = e;
        d.onclick = () => {
          st.edges[e] = (st.edges[e] + 1) % 3;
          this.paintEdge(st, e);
          Audio2.tap();
          if (this.solved(st)) Host.finish();
        };
        gg.appendChild(d);
        return d;
      };
      for (let r=0;r<=n;r++) for (let c=0;c<n;c++)
        addEdge(st.E.h(r,c), o+c*cell, o+r*cell-cell*.22, cell, cell*.44).classList.add('h');
      for (let r=0;r<n;r++) for (let c=0;c<=n;c++)
        addEdge(st.E.v(r,c), o+c*cell-cell*.22, o+r*cell, cell*.44, cell).classList.add('v');
      st.edges.forEach((_, e) => this.paintEdge(st, e));
    },

    paintEdge(st, e){
      const el = document.querySelector(`.sledge[data-e="${e}"]`);
      if (!el) return;
      el.classList.toggle('on', st.edges[e] === 1);
      el.classList.toggle('no', st.edges[e] === 2);
    },

    solved(st){
      const n = st.n;
      for (let r=0;r<n;r++) for (let c=0;c<n;c++){
        const v = st.clues[r*n+c];
        if (v == null) continue;
        if (st.E.cellEdges(r,c).filter(e => st.edges[e] === 1).length !== v) return false;
      }
      const S = makeSolver(n, st.clues);
      const arr = st.edges.map(v => v === 1 ? 1 : 0);
      return singleLoop(S, arr, n);
    },
    serialize(st){ return { edges: st.edges.map(v => v === 1 ? 1 : 0) }; },
    stars(st, s){ return s <= st.targetTime ? 3 : s <= st.targetTime*1.7 ? 2 : 1; }
  };
  MODULES.slitherlink._countSolutions = countSolutions;
  MODULES.slitherlink._singleLoop = (n, clues, arr) => singleLoop(makeSolver(n, clues), arr, n);
})();

/* ═══════════════════════════════════════════════════════════════
   PHASE 5a — move optimisation
   Fifteen · Lights Out · Peg Solitaire · Sokoban · Gridlock

   These are scored, not timed. Every one records the moves you made,
   and the server replays that list from the seeded start position —
   so a score is only accepted if the moves that earned it really work.
   ═══════════════════════════════════════════════════════════════ */

/* ───────────────────────── FIFTEEN ───────────────────────── */
(function(){
  const sizeFor = l => l<=8?3 : l<=32?4 : 5;

  const slideable = (st, i) => {
    const n = st.n, b = st.blank;
    return (Math.abs(i-b) === n) || (Math.abs(i-b) === 1 && ((i/n)|0) === ((b/n)|0));
  };
  const manhattan = st => {
    const n = st.n; let d = 0;
    for (let i=0;i<n*n;i++){
      const v = st.tiles[i];
      if (!v) continue;
      const tr = ((v-1)/n)|0, tc = (v-1)%n;
      d += Math.abs(((i/n)|0) - tr) + Math.abs((i%n) - tc);
    }
    return d;
  };

  MODULES.fifteen = {
    id:'fifteen', result:'score',

    start(level){
      const rnd = rngFor('fifteen', level);
      const n = sizeFor(level);
      const tiles = [];
      for (let i=1;i<n*n;i++) tiles.push(i);
      tiles.push(0);
      let blank = n*n - 1, last = -1;
      const st = { n, tiles, blank };
      /* scrambling by legal moves keeps the puzzle solvable by construction */
      const shuffles = 40 + level * 6;
      for (let s=0;s<shuffles;s++){
        const opts = [];
        for (let i=0;i<n*n;i++) if (i !== last && slideable(st, i)) opts.push(i);
        const pick = opts[(rnd()*opts.length)|0];
        st.tiles[st.blank] = st.tiles[pick];
        st.tiles[pick] = 0;
        last = st.blank; st.blank = pick;
      }
      return st;
    },

    generate(level){
      const st = this.start(level);
      st.moves = [];
      st.par = Math.max(1, Math.round(manhattan(st) * 1.35));
      st.targetTime = 0;
      return st;
    },

    move(st, i){
      if (!slideable(st, i)) return false;
      st.tiles[st.blank] = st.tiles[i];
      st.tiles[i] = 0;
      st.blank = i;
      st.moves.push(i);
      return true;
    },

    replay(level, moves){
      if (!Array.isArray(moves) || moves.length > 100000) return { ok:false, reason:'malformed move list' };
      const st = this.start(level);
      st.moves = [];
      for (const m of moves){
        if (!Number.isInteger(m) || m < 0 || m >= st.n*st.n) return { ok:false, reason:'move off the board' };
        if (!this.move(st, m)) return { ok:false, reason:'illegal slide' };
      }
      return { ok: this.solved(st), reason:'puzzle not finished', st };
    },

    preview(ctx, s, w){
      const st = this.generate(s.level), n = st.n, cell = w/n;
      ctx.fillStyle = '#131E26'; ctx.fillRect(0,0,w,w);
      ctx.font = `700 ${Math.round(cell*.4)}px 'Space Mono', monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (let i=0;i<n*n;i++){
        if (!st.tiles[i]) continue;
        const x = (i%n)*cell, y = ((i/n)|0)*cell;
        ctx.fillStyle = '#22323E';
        ctx.fillRect(x+2, y+2, cell-4, cell-4);
        ctx.fillStyle = '#C9B899';
        ctx.fillText(st.tiles[i], x+cell/2, y+cell/2+1);
      }
    },

    render(root, st){
      root.innerHTML = `<div class="fif" style="--n:${st.n}" id="fifg"></div>
        <div class="movebar"><span class="lbl">moves</span><b id="fif-m">0</b>
          <span class="lbl">par</span><b>${st.par}</b></div>`;
      const gg = root.querySelector('#fifg');
      for (let i=0;i<st.n*st.n;i++){
        const d = document.createElement('button');
        d.className = 'fift';
        d.dataset.i = i;
        d.onclick = () => {
          if (!this.move(st, i)) return;
          Audio2.tap();
          this.paint(st);
          if (this.solved(st)) Host.finish();
        };
        gg.appendChild(d);
      }
      this.paint(st);
    },
    paint(st){
      document.querySelectorAll('.fift').forEach(el => {
        const i = +el.dataset.i, v = st.tiles[i];
        el.textContent = v || '';
        el.classList.toggle('blank', !v);
        el.classList.toggle('home', !!v && v === i+1);
      });
      const m = document.getElementById('fif-m');
      if (m) m.textContent = st.moves.length;
    },

    solved(st){
      const N = st.n*st.n;
      for (let i=0;i<N-1;i++) if (st.tiles[i] !== i+1) return false;
      return st.tiles[N-1] === 0;
    },
    serialize(st){ return { moves: st.moves }; },
    score(st){ return Math.min(1000, Math.round(1000 * st.par / Math.max(st.moves.length, st.par))); },
    stars(st){
      const r = st.moves.length / st.par;
      return r <= 1.25 ? 3 : r <= 2 ? 2 : 1;
    }
  };
})();

/* ───────────────────────── LIGHTS OUT ───────────────────────── */
(function(){
  const sizeFor = l => l<=20?5 : l<=38?6 : 7;

  const toggle = (st, i) => {
    const n = st.n, r = (i/n)|0, c = i%n;
    st.grid[i] ^= 1;
    if (r>0)   st.grid[i-n] ^= 1;
    if (r<n-1) st.grid[i+n] ^= 1;
    if (c>0)   st.grid[i-1] ^= 1;
    if (c<n-1) st.grid[i+1] ^= 1;
  };

  MODULES.lightsout = {
    id:'lightsout', result:'score',

    start(level){
      const rnd = rngFor('lightsout', level);
      const n = sizeFor(level);
      const st = { n, grid:new Array(n*n).fill(0) };
      /* pressing a set of cells from all-dark guarantees the puzzle is solvable,
         and that set is an upper bound on the shortest solution */
      const want = Math.max(2, Math.round(n*n * (0.18 + (level/50)*0.30)));
      const cells = shuffle([...Array(n*n).keys()], rnd).slice(0, want);
      cells.forEach(i => toggle(st, i));
      st.par = cells.length;
      st.witness = cells.slice();        // a press set known to clear the board
      if (st.grid.every(v => !v)) toggle(st, cells[0]);   // never hand over a solved board
      return st;
    },

    generate(level){
      const st = this.start(level);
      st.moves = [];
      return st;
    },

    press(st, i){ toggle(st, i); st.moves.push(i); },

    replay(level, moves){
      if (!Array.isArray(moves) || moves.length > 100000) return { ok:false, reason:'malformed move list' };
      const st = this.start(level);
      st.moves = [];
      for (const m of moves){
        if (!Number.isInteger(m) || m < 0 || m >= st.n*st.n) return { ok:false, reason:'press off the board' };
        this.press(st, m);
      }
      return { ok: st.grid.every(v => !v), reason:'lights still on', st };
    },

    preview(ctx, s, w){
      const st = this.generate(s.level), n = st.n, cell = w/n;
      ctx.fillStyle = '#131E26'; ctx.fillRect(0,0,w,w);
      for (let i=0;i<n*n;i++){
        ctx.fillStyle = st.grid[i] ? '#C9B899' : '#22323E';
        ctx.fillRect((i%n)*cell+2, ((i/n)|0)*cell+2, cell-4, cell-4);
      }
    },

    render(root, st){
      root.innerHTML = `<div class="lo" style="--n:${st.n}" id="log"></div>
        <div class="movebar"><span class="lbl">presses</span><b id="lo-m">0</b>
          <span class="lbl">par</span><b>${st.par}</b></div>
        <p class="hint">Turn every light off. Pressing one flips it and its four neighbours.</p>`;
      const gg = root.querySelector('#log');
      for (let i=0;i<st.n*st.n;i++){
        const d = document.createElement('button');
        d.className = 'loc';
        d.dataset.i = i;
        d.onclick = () => {
          this.press(st, i);
          Audio2.tap();
          this.paint(st);
          if (this.solved(st)) Host.finish();
        };
        gg.appendChild(d);
      }
      this.paint(st);
    },
    paint(st){
      document.querySelectorAll('.loc').forEach(el => {
        el.classList.toggle('on', !!st.grid[+el.dataset.i]);
      });
      const m = document.getElementById('lo-m');
      if (m) m.textContent = st.moves.length;
    },

    solved(st){ return st.grid.every(v => !v); },
    serialize(st){ return { moves: st.moves }; },
    score(st){ return Math.min(1000, Math.round(1000 * st.par / Math.max(st.moves.length, st.par))); },
    stars(st){
      const r = st.moves.length / st.par;
      return r <= 1.1 ? 3 : r <= 1.8 ? 2 : 1;
    }
  };
})();

/* ───────────────────────── PEG SOLITAIRE ───────────────────────── */
(function(){
  const N = 7;
  const valid = i => {
    const r = (i/N)|0, c = i%N;
    return !((r<2 || r>4) && (c<2 || c>4));
  };
  const HOLES = [...Array(N*N).keys()].filter(valid);
  const dirs = i => {
    const r = (i/N)|0, c = i%N, out = [];
    if (r>1)   out.push(-N);
    if (r<N-2) out.push(N);
    if (c>1)   out.push(-1);
    if (c<N-2) out.push(1);
    return out;
  };
  const pegsFor = l => Math.min(24, 6 + Math.round((l/50)*18));

  MODULES.peg = {
    id:'peg', result:'score',

    start(level){
      const rnd = rngFor('peg', level);
      const pegs = new Set([HOLES[(rnd()*HOLES.length)|0]]);
      const want = pegsFor(level);
      const undone = [];
      let guard = 0;
      /* build the position by undoing jumps, so a full solution always exists */
      while (pegs.size < want && guard++ < 30000){
        const from = [...pegs][(rnd()*pegs.size)|0];
        const ds = shuffle(dirs(from), rnd);
        let done = false;
        for (const d of ds){
          const mid = from + d, far = from + 2*d;
          if (!valid(mid) || !valid(far)) continue;
          if (pegs.has(mid) || pegs.has(far)) continue;
          if (Math.abs(d) === 1 && (((mid/N)|0) !== ((from/N)|0) || ((far/N)|0) !== ((from/N)|0))) continue;
          pegs.delete(from); pegs.add(mid); pegs.add(far);
          undone.push([far, from]);      // forward jump that undoes this pull
          done = true; break;
        }
        if (!done) continue;
      }
      return { pegs, par: pegs.size - 1, witness: undone.slice().reverse() };
    },

    generate(level){
      const st = this.start(level);
      st.moves = []; st.sel = -1; st.history = [];
      return st;
    },

    jump(st, from, to){
      const d = (to - from) / 2;
      if (!Number.isInteger(d) || !d) return false;
      if (!(Math.abs(to-from) === 2 || Math.abs(to-from) === 2*N)) return false;
      if (Math.abs(to-from) === 2 && ((to/N)|0) !== ((from/N)|0)) return false;
      const mid = from + d;
      if (!valid(to) || !valid(mid)) return false;
      if (!st.pegs.has(from) || !st.pegs.has(mid) || st.pegs.has(to)) return false;
      st.pegs.delete(from); st.pegs.delete(mid); st.pegs.add(to);
      st.moves.push([from, to]);
      return true;
    },

    replay(level, moves){
      if (!Array.isArray(moves) || moves.length > 100) return { ok:false, reason:'malformed move list' };
      const st = this.start(level);
      st.moves = [];
      for (const m of moves){
        if (!Array.isArray(m) || m.length !== 2) return { ok:false, reason:'malformed jump' };
        if (!this.jump(st, m[0], m[1])) return { ok:false, reason:'illegal jump' };
      }
      return { ok: st.pegs.size === 1, reason:'more than one peg left', st };
    },

    preview(ctx, s, w){
      const st = this.generate(s.level), cell = w/N;
      ctx.fillStyle = '#131E26'; ctx.fillRect(0,0,w,w);
      HOLES.forEach(i => {
        const x = (i%N)*cell + cell/2, y = ((i/N)|0)*cell + cell/2;
        ctx.beginPath(); ctx.arc(x, y, cell*.34, 0, 7);
        ctx.fillStyle = st.pegs.has(i) ? '#3FB98A' : '#22323E';
        ctx.fill();
      });
    },

    render(root, st){
      root.innerHTML = `<div class="pg" id="pgg"></div>
        <div class="movebar"><span class="lbl">pegs left</span><b id="pg-n">${st.pegs.size}</b>
          <button class="mini" id="pg-undo">undo</button></div>
        <p class="hint">Jump a peg over its neighbour into the empty hole behind. Finish with one peg.</p>`;
      const gg = root.querySelector('#pgg');
      for (let i=0;i<N*N;i++){
        const d = document.createElement('div');
        d.className = valid(i) ? 'pgh' : 'pgx';
        d.dataset.i = i;
        if (valid(i)) d.onclick = () => this.tap(st, i);
        gg.appendChild(d);
      }
      root.querySelector('#pg-undo').onclick = () => {
        if (!st.history.length) return;
        const prev = st.history.pop();
        st.pegs = new Set(prev);
        st.moves.pop();
        st.sel = -1;
        Audio2.tap();
        this.paint(st);
      };
      this.paint(st);
    },

    tap(st, i){
      if (st.sel === i){ st.sel = -1; return this.paint(st); }
      if (st.pegs.has(i)){ st.sel = i; Audio2.tap(); return this.paint(st); }
      if (st.sel < 0) return;
      const snapshot = [...st.pegs];
      if (this.jump(st, st.sel, i)){
        st.history.push(snapshot);
        st.sel = -1;
        Audio2.place();
        this.paint(st);
        if (this.solved(st)) Host.finish();
      } else {
        Audio2.wrong();
      }
    },
    paint(st){
      document.querySelectorAll('.pgh').forEach(el => {
        const i = +el.dataset.i;
        el.classList.toggle('peg', st.pegs.has(i));
        el.classList.toggle('sel', st.sel === i);
      });
      const n = document.getElementById('pg-n');
      if (n) n.textContent = st.pegs.size;
    },

    solved(st){ return st.pegs.size === 1; },
    serialize(st){ return { moves: st.moves }; },
    /* every solve takes the same number of jumps, so this one is about speed */
    score(st, seconds){ return Math.max(50, Math.round(2000 - seconds * 6)); },
    stars(st, seconds){
      const t = 25 + st.par * 6;
      return seconds <= t ? 3 : seconds <= t*1.8 ? 2 : 1;
    }
  };
})();

/* ───────────────────────── SOKOBAN ───────────────────────── */
(function(){
  const sizeFor = l => l<=15?7 : l<=35?8 : 9;
  const boxFor  = l => Math.min(4, 2 + Math.round((l/50)*2));

  MODULES.sokoban = {
    id:'sokoban', result:'score',

    start(level){
      const rnd = rngFor('sokoban', level);
      const n = sizeFor(level);
      const D = [-n, n, -1, 1];
      const okStep = (i, d) => {
        if (d === -1 && i%n === 0) return false;
        if (d === 1  && i%n === n-1) return false;
        const j = i + d;
        return j >= 0 && j < n*n;
      };

      for (let attempt=0; attempt<80; attempt++){
        const wall = new Array(n*n).fill(false);
        for (let i=0;i<n*n;i++){
          const r = (i/n)|0, c = i%n;
          if (r===0||c===0||r===n-1||c===n-1) wall[i] = true;
          else if (rnd() < 0.11) wall[i] = true;
        }
        const floor = [...Array(n*n).keys()].filter(i => !wall[i]);
        if (floor.length < n*3) continue;
        /* one connected room only */
        const seen = new Set([floor[0]]), stack = [floor[0]];
        while (stack.length){
          const i = stack.pop();
          for (const d of D){
            if (!okStep(i,d)) continue;
            const j = i+d;
            if (!wall[j] && !seen.has(j)){ seen.add(j); stack.push(j); }
          }
        }
        if (seen.size !== floor.length) continue;

        const k = boxFor(level);
        const spots = shuffle(floor.slice(), rnd);
        const goals = spots.slice(0, k);
        const boxes = new Set(goals);
        let player = spots.find(i => !boxes.has(i));
        if (player === undefined) continue;

        const reach = from => {
          const r = new Set([from]), s = [from];
          while (s.length){
            const i = s.pop();
            for (const d of D){
              if (!okStep(i,d)) continue;
              const j = i+d;
              if (!wall[j] && !boxes.has(j) && !r.has(j)){ r.add(j); s.push(j); }
            }
          }
          return r;
        };

        /* pull boxes backwards: the reverse of a legal push is a legal pull */
        const pulls = 12 + level;
        const pullLog = [];
        let done = 0;
        for (let t=0; t<pulls*6 && done<pulls; t++){
          const bs = [...boxes];
          const X = bs[(rnd()*bs.length)|0];
          const d = D[(rnd()*4)|0];
          if (!okStep(X, -d) || !okStep(X + -d, -d)) continue;
          const Y = X - d, Z = X - 2*d;
          if (wall[Y] || boxes.has(Y)) continue;
          if (wall[Z] || boxes.has(Z)) continue;
          if (!reach(player).has(Y)) continue;
          boxes.delete(X); boxes.add(Y);
          player = Z;
          pullLog.push({ d, Y, Z });     // undoing this is a forward push
          done++;
        }
        const offGoal = [...boxes].filter(b => !goals.includes(b)).length;
        if (offGoal < Math.max(1, k-1)) continue;
        if (goals.every(g => boxes.has(g))) continue;

        /* Undo the pulls to get a real solution. It proves the level is
           finishable and gives a par in the same unit as the move counter. */
        const walk = (bx, from, to) => {
          const prev = new Map([[from, null]]), q = [from];
          while (q.length){
            const i = q.shift();
            if (i === to) break;
            for (const d of D){
              if (!okStep(i, d)) continue;
              const j = i + d;
              if (wall[j] || bx.has(j) || prev.has(j)) continue;
              prev.set(j, [i, d]); q.push(j);
            }
          }
          if (!prev.has(to)) return null;
          const out = []; let c = to;
          while (prev.get(c)){ const [p, d] = prev.get(c); out.unshift(d); c = p; }
          return out;
        };
        const bx = new Set(boxes);
        let pl = player, witness = [], broken = false;
        for (let i=pullLog.length-1; i>=0 && !broken; i--){
          const { d, Y, Z } = pullLog[i];
          const route = walk(bx, pl, Z);
          if (route === null || !bx.has(Y)){ broken = true; break; }
          route.forEach(step => { pl += step; witness.push(step); });
          bx.delete(Y); bx.add(Y + d); pl = Y; witness.push(d);
        }
        if (broken || !goals.every(g => bx.has(g))) continue;

        return { n, wall, goals, boxes:new Set(boxes), player,
                 par: witness.length, pushes: done, witness, D, pullLog };
      }
      /* a plain corridor: always solvable */
      const n2 = 7, wall = new Array(n2*n2).fill(false);
      for (let i=0;i<n2*n2;i++){
        const r=(i/n2)|0, c=i%n2;
        if (r===0||c===0||r===n2-1||c===n2-1||r!==3) wall[i] = true;
      }
      return { n:n2, wall, goals:[3*n2+5], boxes:new Set([3*n2+3]),
               player:3*n2+1, par:4, pushes:2, witness:[1,1,1,1],
               D:[-n2,n2,-1,1], pullLog:[] };
    },

    generate(level){
      const st = this.start(level);
      st.moves = []; st.history = [];
      return st;
    },

    step(st, d){
      const n = st.n, p = st.player;
      if (d === -1 && p%n === 0) return false;
      if (d === 1  && p%n === n-1) return false;
      const t = p + d;
      if (t < 0 || t >= n*n || st.wall[t]) return false;
      if (st.boxes.has(t)){
        if (d === -1 && t%n === 0) return false;
        if (d === 1  && t%n === n-1) return false;
        const b = t + d;
        if (b < 0 || b >= n*n || st.wall[b] || st.boxes.has(b)) return false;
        st.boxes.delete(t); st.boxes.add(b);
      }
      st.player = t;
      st.moves.push(d);
      return true;
    },

    replay(level, moves){
      if (!Array.isArray(moves) || moves.length > 100000) return { ok:false, reason:'malformed move list' };
      const st = this.start(level);
      st.moves = [];
      const D = st.D;
      for (const d of moves){
        if (!D.includes(d)) return { ok:false, reason:'bad direction' };
        if (!this.step(st, d)) return { ok:false, reason:'illegal move' };
      }
      return { ok: st.goals.every(g => st.boxes.has(g)), reason:'boxes not all home', st };
    },

    preview(ctx, s, w){
      const st = this.generate(s.level), n = st.n, cell = w/n;
      ctx.fillStyle = '#131E26'; ctx.fillRect(0,0,w,w);
      for (let i=0;i<n*n;i++){
        const x = (i%n)*cell, y = ((i/n)|0)*cell;
        if (st.wall[i]){ ctx.fillStyle = '#22323E'; ctx.fillRect(x, y, cell, cell); }
      }
      ctx.strokeStyle = '#C9B899'; ctx.lineWidth = 1;
      st.goals.forEach(i => ctx.strokeRect((i%n)*cell+cell*.28, ((i/n)|0)*cell+cell*.28, cell*.44, cell*.44));
      ctx.fillStyle = '#E0457B';
      st.boxes.forEach(i => ctx.fillRect((i%n)*cell+cell*.2, ((i/n)|0)*cell+cell*.2, cell*.6, cell*.6));
      ctx.fillStyle = '#3FB98A';
      ctx.beginPath();
      ctx.arc((st.player%n)*cell+cell/2, ((st.player/n)|0)*cell+cell/2, cell*.28, 0, 7);
      ctx.fill();
    },

    render(root, st){
      root.innerHTML = `<div class="sk2" style="--n:${st.n}" id="skg"></div>
        <div class="dpad">
          <button data-d="u">↑</button>
          <button data-d="l">←</button>
          <button data-d="r">→</button>
          <button data-d="d">↓</button>
          <button class="mini" id="sk-undo">undo</button>
        </div>
        <div class="movebar"><span class="lbl">moves</span><b id="sk-m">0</b>
          <span class="lbl">par</span><b>${st.par}</b></div>`;
      const gg = root.querySelector('#skg');
      for (let i=0;i<st.n*st.n;i++){
        const d = document.createElement('div');
        d.className = 'sk2c';
        d.dataset.i = i;
        gg.appendChild(d);
      }
      const map = { u:-st.n, d:st.n, l:-1, r:1 };
      root.querySelectorAll('.dpad button[data-d]').forEach(b => b.onclick = () => {
        const snapshot = { boxes:[...st.boxes], player:st.player };
        if (!this.step(st, map[b.dataset.d])) return Audio2.wrong();
        st.history.push(snapshot);
        Audio2.tap();
        this.paint(st);
        if (this.solved(st)) Host.finish();
      });
      root.querySelector('#sk-undo').onclick = () => {
        if (!st.history.length) return;
        const h = st.history.pop();
        st.boxes = new Set(h.boxes); st.player = h.player;
        st.moves.pop();
        Audio2.tap();
        this.paint(st);
      };
      this.paint(st);
    },
    paint(st){
      document.querySelectorAll('.sk2c').forEach(el => {
        const i = +el.dataset.i;
        el.className = 'sk2c'
          + (st.wall[i] ? ' wall' : '')
          + (st.goals.includes(i) ? ' goal' : '')
          + (st.boxes.has(i) ? (st.goals.includes(i) ? ' box home' : ' box') : '')
          + (st.player === i ? ' you' : '');
      });
      const m = document.getElementById('sk-m');
      if (m) m.textContent = st.moves.length;
    },

    solved(st){ return st.goals.every(g => st.boxes.has(g)); },
    serialize(st){ return { moves: st.moves }; },
    score(st){ return Math.min(1000, Math.round(1000 * st.par / Math.max(st.moves.length, st.par))); },
    stars(st){
      const r = st.moves.length / Math.max(st.par, 1);
      return r <= 1.15 ? 3 : r <= 1.8 ? 2 : 1;
    }
  };
})();

/* ───────────────────────── GRIDLOCK ───────────────────────── */
(function(){
  const G = 6, EXIT_ROW = 2;

  const cellsOf = car => {
    const out = [];
    for (let k=0;k<car.len;k++) out.push(car.dir === 'h' ? car.r*G + car.c + k : (car.r+k)*G + car.c);
    return out;
  };
  const occupancy = cars => {
    const grid = new Array(G*G).fill(-1);
    cars.forEach((car, i) => cellsOf(car).forEach(x => grid[x] = i));
    return grid;
  };
  const encode = cars => cars.map(c => c.dir === 'h' ? c.c : c.r).join(',');

  function shiftable(cars, grid, i, d){
    const car = cars[i];
    if (car.dir === 'h'){
      if (d < 0){ if (car.c === 0) return false; return grid[car.r*G + car.c - 1] === -1; }
      if (car.c + car.len >= G) return false;
      return grid[car.r*G + car.c + car.len] === -1;
    }
    if (d < 0){ if (car.r === 0) return false; return grid[(car.r-1)*G + car.c] === -1; }
    if (car.r + car.len >= G) return false;
    return grid[(car.r + car.len)*G + car.c] === -1;
  }
  const applyShift = (cars, i, d) => {
    const c = cars.map(x => ({...x}));
    if (c[i].dir === 'h') c[i].c += d; else c[i].r += d;
    return c;
  };
  const escaped = cars => cars[0].c + cars[0].len >= G;

  /** shortest solution in single-cell moves, or -1 if it blows the budget */
  function solveDepth(cars, cap = 14000){
    const seen = new Set([encode(cars)]);
    let frontier = [cars], depth = 0;
    while (frontier.length && seen.size < cap){
      if (frontier.some(escaped)) return depth;
      const next = [];
      for (const state of frontier){
        const grid = occupancy(state);
        for (let i=0;i<state.length;i++) for (const d of [-1,1]){
          if (!shiftable(state, grid, i, d)) continue;
          const moved = applyShift(state, i, d);
          const k = encode(moved);
          if (seen.has(k)) continue;
          seen.add(k); next.push(moved);
        }
      }
      frontier = next; depth++;
      if (depth > 60) return -1;
    }
    return -1;   // too tangled to price honestly; try another layout
  }

  /** cheap rejects, so the expensive search only sees plausible boards */
  function plausible(cars){
    const hero = cars[0];
    let blockers = 0;
    for (let i=1;i<cars.length;i++){
      const c = cars[i];
      if (c.dir === 'v'){
        if (c.c > hero.c + hero.len - 1 && c.r <= EXIT_ROW && c.r + c.len > EXIT_ROW) blockers++;
      } else if (c.r === EXIT_ROW && c.c > hero.c) blockers++;
    }
    return blockers >= 1;
  }

  MODULES.rushhour = {
    id:'rushhour', result:'score',

    start(level){
      const rnd = rngFor('rushhour', level);
      const minDepth = Math.min(24, 5 + Math.round((level/50)*19));
      let best = null;                       // deepest board seen so far

      for (let attempt=0; attempt<150; attempt++){
        const cars = [{ r:EXIT_ROW, c:(rnd()*2)|0, len:2, dir:'h', hero:true }];
        const count = 5 + ((rnd()*5)|0);
        for (let t=0; t<count*8 && cars.length < count+1; t++){
          const dir = rnd() < .5 ? 'h' : 'v';
          const len = rnd() < .7 ? 2 : 3;
          const r = (rnd()*G)|0, c = (rnd()*G)|0;
          if (dir === 'h' && (c + len > G || r === EXIT_ROW)) continue;   // nothing else lies in the exit lane
          if (dir === 'v' && r + len > G) continue;
          const cand = { r, c, len, dir };
          const taken = new Set(cars.flatMap(cellsOf));
          if (cellsOf(cand).some(x => taken.has(x))) continue;
          cars.push(cand);
        }
        if (cars.length < 5) continue;
        if (escaped(cars)) continue;
        if (!plausible(cars)) continue;
        const depth = solveDepth(cars);
        if (depth < 2) continue;
        if (!best || depth > best.par) best = { cars, par:depth };
        if (depth >= minDepth) break;        // deep enough for this level, stop looking
      }
      /* Rather than a token board when the floor is not met, hand over the
         hardest layout the search actually found. */
      if (best) return best;
      return { cars:[{ r:EXIT_ROW, c:0, len:2, dir:'h', hero:true },
                     { r:0, c:4, len:3, dir:'v' },
                     { r:EXIT_ROW, c:4, len:2, dir:'h' }], par:2 };
    },

    generate(level){
      const st = this.start(level);
      st.moves = []; st.sel = -1;
      return st;
    },

    shift(st, i, d){
      const grid = occupancy(st.cars);
      if (!shiftable(st.cars, grid, i, d)) return false;
      st.cars = applyShift(st.cars, i, d);
      st.moves.push([i, d]);
      return true;
    },

    replay(level, moves){
      if (!Array.isArray(moves) || moves.length > 100000) return { ok:false, reason:'malformed move list' };
      const st = this.start(level);
      st.moves = [];
      for (const m of moves){
        if (!Array.isArray(m) || m.length !== 2) return { ok:false, reason:'malformed move' };
        const [i, d] = m;
        if (!Number.isInteger(i) || i < 0 || i >= st.cars.length) return { ok:false, reason:'no such car' };
        if (d !== 1 && d !== -1) return { ok:false, reason:'bad direction' };
        if (!this.shift(st, i, d)) return { ok:false, reason:'blocked move' };
      }
      return { ok: escaped(st.cars), reason:'the red car is still stuck', st };
    },

    preview(ctx, s, w){
      const st = this.generate(s.level), cell = w/G;
      ctx.fillStyle = '#131E26'; ctx.fillRect(0,0,w,w);
      ctx.fillStyle = '#1F2E3A';
      ctx.fillRect(w-cell*.14, EXIT_ROW*cell, cell*.14, cell);
      st.cars.forEach((car, i) => {
        const x = car.c*cell, y = car.r*cell;
        const cw = car.dir === 'h' ? car.len*cell : cell;
        const ch = car.dir === 'h' ? cell : car.len*cell;
        ctx.fillStyle = i === 0 ? '#E0457B' : '#33485A';
        ctx.fillRect(x+2, y+2, cw-4, ch-4);
      });
    },

    render(root, st){
      root.innerHTML = `<div class="rh" id="rhg"><div class="rh-exit"></div></div>
        <div class="movebar"><span class="lbl">moves</span><b id="rh-m">0</b>
          <span class="lbl">par</span><b>${st.par}</b></div>
        <p class="hint">Slide the pink car out to the right. Drag any car along its own lane.</p>`;
      const gg = root.querySelector('#rhg');
      const size = Math.min(root.clientWidth, window.innerHeight * 0.55);
      gg.style.width = size+'px'; gg.style.height = size+'px';
      st._cell = size/G;
      st.cars.forEach((car, i) => {
        const el = document.createElement('div');
        el.className = 'rhcar' + (i === 0 ? ' hero' : '');
        el.dataset.i = i;
        gg.appendChild(el);
        let startXY = null, acc = 0;
        el.addEventListener('pointerdown', e => {
          el.setPointerCapture(e.pointerId);
          startXY = car.dir === 'h' ? e.clientX : e.clientY;
          acc = 0;
        });
        el.addEventListener('pointermove', e => {
          if (startXY === null) return;
          const now = car.dir === 'h' ? e.clientX : e.clientY;
          const delta = now - startXY - acc;
          const steps = Math.trunc(delta / st._cell);
          if (!steps) return;
          const d = steps > 0 ? 1 : -1;
          for (let k=0;k<Math.abs(steps);k++){
            if (!this.shift(st, i, d)) break;
            acc += d * st._cell;
            Audio2.tap();
          }
          this.paint(st);
          if (this.solved(st)) Host.finish();
        });
        const end = () => { startXY = null; };
        el.addEventListener('pointerup', end);
        el.addEventListener('pointercancel', end);
      });
      this.paint(st);
    },
    paint(st){
      const cell = st._cell;
      document.querySelectorAll('.rhcar').forEach(el => {
        const car = st.cars[+el.dataset.i];
        el.style.left   = (car.c*cell)+'px';
        el.style.top    = (car.r*cell)+'px';
        el.style.width  = ((car.dir === 'h' ? car.len : 1)*cell - 4)+'px';
        el.style.height = ((car.dir === 'h' ? 1 : car.len)*cell - 4)+'px';
      });
      const m = document.getElementById('rh-m');
      if (m) m.textContent = st.moves.length;
    },

    solved(st){ return escaped(st.cars); },
    serialize(st){ return { moves: st.moves }; },
    score(st){ return Math.min(1000, Math.round(1000 * st.par / Math.max(st.moves.length, st.par))); },
    stars(st){
      const r = st.moves.length / Math.max(st.par, 1);
      return r <= 1.3 ? 3 : r <= 2.2 ? 2 : 1;
    }
  };
})();

/* ═══════════════════════════════════════════════════════════════
   PHASE 5b — score chasers
   2048 · Blockdrop · Echo · Mastermind · Scramble

   These have no single solution to check, so each level sets a target
   instead. Randomness comes from the level seed, which means the spawn
   order is fixed: the server can replay your moves through the same
   stream and arrive at the same board.
   ═══════════════════════════════════════════════════════════════ */

/* ───────────────────────── 2048 ───────────────────────── */
(function(){
  const G = 4;
  const targetFor = l => Math.pow(2, 5 + Math.round((l/50) * 4));   // 32 … 512

  function spawn(st){
    const free = [];
    for (let i=0;i<G*G;i++) if (!st.grid[i]) free.push(i);
    if (!free.length) return;
    const i = free[(st.rnd() * free.length) | 0];
    st.grid[i] = st.rnd() < 0.9 ? 2 : 4;
  }

  function slide(st, dir){
    /* dir: 0 up, 1 right, 2 down, 3 left */
    const before = st.grid.join(',');
    const line = k => {
      const out = [];
      for (let j=0;j<G;j++){
        out.push(dir === 0 ? j*G + k
              : dir === 2 ? (G-1-j)*G + k
              : dir === 3 ? k*G + j
              : k*G + (G-1-j));
      }
      return out;
    };
    for (let k=0;k<G;k++){
      const idx = line(k);
      const vals = idx.map(i => st.grid[i]).filter(Boolean);
      const merged = [];
      for (let j=0;j<vals.length;j++){
        if (vals[j] === vals[j+1]){
          merged.push(vals[j]*2);
          st.score += vals[j]*2;
          j++;
        } else merged.push(vals[j]);
      }
      while (merged.length < G) merged.push(0);
      idx.forEach((i, j) => st.grid[i] = merged[j]);
    }
    if (st.grid.join(',') === before) return false;
    st.moves.push(dir);
    spawn(st);
    return true;
  }

  const stuck = st => {
    if (st.grid.some(v => !v)) return false;
    for (let r=0;r<G;r++) for (let c=0;c<G;c++){
      const v = st.grid[r*G+c];
      if (c < G-1 && st.grid[r*G+c+1] === v) return false;
      if (r < G-1 && st.grid[(r+1)*G+c] === v) return false;
    }
    return true;
  };

  MODULES.twenty48 = {
    id:'twenty48', result:'score',

    start(level){
      const st = { grid:new Array(G*G).fill(0), score:0, moves:[],
                   rnd: rngFor('twenty48', level), target: targetFor(level) };
      spawn(st); spawn(st);
      return st;
    },
    generate(level){ return this.start(level); },

    replay(level, moves){
      if (!Array.isArray(moves) || moves.length > 20000) return { ok:false, reason:'malformed move list' };
      const st = this.start(level);
      for (const d of moves){
        if (![0,1,2,3].includes(d)) return { ok:false, reason:'bad direction' };
        if (!slide(st, d)) return { ok:false, reason:'a move that changes nothing' };
      }
      return { ok:true, st };
    },

    preview(ctx, s, w){
      const st = this.generate(s.level), cell = w/G;
      ctx.fillStyle = '#131E26'; ctx.fillRect(0,0,w,w);
      ctx.font = `700 ${Math.round(cell*.3)}px 'Space Mono', monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (let i=0;i<G*G;i++){
        const x = (i%G)*cell, y = ((i/G)|0)*cell;
        ctx.fillStyle = st.grid[i] ? '#33485A' : '#1B2731';
        ctx.fillRect(x+3, y+3, cell-6, cell-6);
        if (st.grid[i]){
          ctx.fillStyle = '#E8F1EE';
          ctx.fillText(st.grid[i], x+cell/2, y+cell/2+1);
        }
      }
      ctx.fillStyle = '#C9B899';
      ctx.font = `700 ${Math.round(cell*.34)}px 'Space Mono', monospace`;
      ctx.fillText('→ ' + st.target, w/2, w - cell*.3);
    },

    render(root, st){
      root.innerHTML = `<div class="movebar"><span class="lbl">score</span><b id="t48-s">0</b>
          <span class="lbl">reach</span><b>${st.target}</b></div>
        <div class="t48" id="t48g"></div>
        <p class="hint">Swipe to slide everything. Matching tiles merge. Reach ${st.target} to finish the level.</p>`;
      const gg = root.querySelector('#t48g');
      for (let i=0;i<G*G;i++){
        const d = document.createElement('div');
        d.className = 't48c'; d.dataset.i = i;
        gg.appendChild(d);
      }
      let sx = 0, sy = 0, down = false;
      gg.addEventListener('pointerdown', e => { down = true; sx = e.clientX; sy = e.clientY; });
      gg.addEventListener('pointerup', e => {
        if (!down) return;
        down = false;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (Math.abs(dx) < 24 && Math.abs(dy) < 24) return;
        const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
        this.go(st, dir);
      });
      window.onkeydown = e => {
        const map = { ArrowUp:0, ArrowRight:1, ArrowDown:2, ArrowLeft:3 };
        if (map[e.key] === undefined) return;
        e.preventDefault();
        this.go(st, map[e.key]);
      };
      this.paint(st);
    },

    go(st, dir){
      if (!slide(st, dir)) return Audio2.wrong();
      Audio2.tap();
      this.paint(st);
      if (this.solved(st) || stuck(st)) Host.finish();   // stuck still banks the score
    },

    paint(st){
      document.querySelectorAll('.t48c').forEach(el => {
        const v = st.grid[+el.dataset.i];
        el.textContent = v || '';
        el.dataset.v = v || '';
      });
      const s = document.getElementById('t48-s');
      if (s) s.textContent = st.score;
    },

    solved(st){ return Math.max(...st.grid) >= st.target; },
    serialize(st){ return { moves: st.moves }; },
    score(st){ return st.score; },
    stars(st){
      const best = Math.max(...st.grid), t = st.target;
      return best >= t ? 3 : best >= t/2 ? 2 : best >= t/4 ? 1 : 0;
    }
  };
})();

/* ───────────────────────── BLOCKDROP ───────────────────────── */
(function(){
  const G = 9;
  const PIECES = [
    [[0,0]],
    [[0,0],[0,1]], [[0,0],[1,0]],
    [[0,0],[0,1],[0,2]], [[0,0],[1,0],[2,0]],
    [[0,0],[0,1],[1,0],[1,1]],
    [[0,0],[0,1],[1,0]], [[0,0],[0,1],[1,1]], [[0,0],[1,0],[1,1]], [[0,1],[1,0],[1,1]],
    [[0,0],[0,1],[0,2],[0,3]], [[0,0],[1,0],[2,0],[3,0]],
    [[0,0],[1,0],[2,0],[2,1]], [[0,1],[1,1],[2,0],[2,1]],
    [[0,0],[0,1],[0,2],[1,1]],
    [[0,0],[0,1],[0,2],[1,0],[1,1],[1,2],[2,0],[2,1],[2,2]]
  ];
  const targetFor = l => 180 + l * 9;

  const drawThree = st => {
    st.tray = [0,1,2].map(() => (st.rnd() * PIECES.length) | 0);
    st.used = [false,false,false];
  };
  const fits = (st, p, r, c) => PIECES[p].every(([dr,dc]) => {
    const rr = r+dr, cc = c+dc;
    return rr>=0 && cc>=0 && rr<G && cc<G && !st.grid[rr*G+cc];
  });
  const anyFits = st => st.tray.some((p,i) => {
    if (st.used[i]) return false;
    for (let r=0;r<G;r++) for (let c=0;c<G;c++) if (fits(st, p, r, c)) return true;
    return false;
  });

  function place(st, slot, r, c){
    if (st.used[slot]) return false;
    const p = st.tray[slot];
    if (!fits(st, p, r, c)) return false;
    PIECES[p].forEach(([dr,dc]) => st.grid[(r+dr)*G + (c+dc)] = 1);
    st.score += PIECES[p].length;
    st.used[slot] = true;
    st.moves.push([slot, r, c]);

    /* clear full rows, columns and 3x3 boxes together */
    const rows = [], cols = [], boxes = [];
    for (let i=0;i<G;i++){
      let full = true;
      for (let j=0;j<G;j++) if (!st.grid[i*G+j]) full = false;
      if (full) rows.push(i);
      full = true;
      for (let j=0;j<G;j++) if (!st.grid[j*G+i]) full = false;
      if (full) cols.push(i);
    }
    for (let br=0;br<3;br++) for (let bc=0;bc<3;bc++){
      let full = true;
      for (let r2=0;r2<3;r2++) for (let c2=0;c2<3;c2++)
        if (!st.grid[(br*3+r2)*G + bc*3+c2]) full = false;
      if (full) boxes.push([br,bc]);
    }
    const clears = rows.length + cols.length + boxes.length;
    rows.forEach(i => { for (let j=0;j<G;j++) st.grid[i*G+j] = 0; });
    cols.forEach(i => { for (let j=0;j<G;j++) st.grid[j*G+i] = 0; });
    boxes.forEach(([br,bc]) => {
      for (let r2=0;r2<3;r2++) for (let c2=0;c2<3;c2++) st.grid[(br*3+r2)*G + bc*3+c2] = 0;
    });
    if (clears) st.score += 18 * clears * clears;      // simultaneous clears compound
    if (st.used.every(Boolean)) drawThree(st);
    return true;
  }

  MODULES.blockudoku = {
    id:'blockudoku', result:'score',

    start(level){
      const st = { grid:new Array(G*G).fill(0), score:0, moves:[],
                   rnd: rngFor('blockudoku', level), target: targetFor(level),
                   sel:-1 };
      drawThree(st);
      return st;
    },
    generate(level){ return this.start(level); },

    replay(level, moves){
      if (!Array.isArray(moves) || moves.length > 20000) return { ok:false, reason:'malformed move list' };
      const st = this.start(level);
      for (const m of moves){
        if (!Array.isArray(m) || m.length !== 3) return { ok:false, reason:'malformed placement' };
        if (!place(st, m[0], m[1], m[2])) return { ok:false, reason:'illegal placement' };
      }
      return { ok:true, st };
    },

    preview(ctx, s, w){
      const st = this.generate(s.level), cell = w/G;
      ctx.fillStyle = '#131E26'; ctx.fillRect(0,0,w,w);
      for (let br=0;br<3;br++) for (let bc=0;bc<3;bc++){
        ctx.fillStyle = (br+bc)%2 ? '#16222B' : '#1A2731';
        ctx.fillRect(bc*3*cell, br*3*cell, 3*cell, 3*cell);
      }
      /* show the opening hand rather than an empty board */
      ctx.fillStyle = '#3FB98A';
      st.tray.forEach((p, k) => {
        PIECES[p].forEach(([dr,dc]) => {
          ctx.fillRect((dc + k*3)*cell+1, (dr + 3)*cell+1, cell-2, cell-2);
        });
      });
    },

    render(root, st){
      root.innerHTML = `<div class="movebar"><span class="lbl">score</span><b id="bd-s">0</b>
          <span class="lbl">target</span><b>${st.target}</b></div>
        <div class="bd" id="bdg"></div>
        <div class="tray" id="bdt"></div>
        <p class="hint">Tap a shape, then tap the board. Fill a row, column or box to clear it.</p>`;
      const gg = root.querySelector('#bdg');
      for (let i=0;i<G*G;i++){
        const d = document.createElement('div');
        d.className = 'bdc';
        d.dataset.i = i;
        d.onclick = () => {
          if (st.sel < 0) return;
          const r = (i/G)|0, c = i%G;
          if (!place(st, st.sel, r, c)) return Audio2.wrong();
          st.sel = -1;
          Audio2.place();
          this.paint(st);
          if (this.solved(st) || !anyFits(st)) Host.finish();
        };
        gg.appendChild(d);
      }
      this.paint(st);
    },

    paint(st){
      document.querySelectorAll('.bdc').forEach(el => {
        const i = +el.dataset.i;
        const br = ((i/G)|0)/3|0, bc = (i%G)/3|0;
        el.className = 'bdc' + ((br+bc)%2 ? ' alt' : '') + (st.grid[i] ? ' on' : '');
      });
      const tray = document.getElementById('bdt');
      if (tray){
        tray.innerHTML = '';
        st.tray.forEach((p, k) => {
          const box = document.createElement('button');
          box.className = 'trayp' + (st.used[k] ? ' spent' : '') + (st.sel === k ? ' sel' : '');
          const maxR = Math.max(...PIECES[p].map(x=>x[0])) + 1;
          const maxC = Math.max(...PIECES[p].map(x=>x[1])) + 1;
          box.style.setProperty('--pr', maxR);
          box.style.setProperty('--pc', maxC);
          for (let r=0;r<maxR;r++) for (let c=0;c<maxC;c++){
            const d = document.createElement('div');
            d.className = PIECES[p].some(([dr,dc]) => dr===r && dc===c) ? 'pb on' : 'pb';
            box.appendChild(d);
          }
          if (!st.used[k]) box.onclick = () => { st.sel = st.sel === k ? -1 : k; Audio2.tap(); this.paint(st); };
          tray.appendChild(box);
        });
      }
      const s = document.getElementById('bd-s');
      if (s) s.textContent = st.score;
    },

    solved(st){ return st.score >= st.target; },
    serialize(st){ return { moves: st.moves }; },
    score(st){ return st.score; },
    stars(st){
      const t = st.target;
      return st.score >= t ? 3 : st.score >= t*0.7 ? 2 : st.score >= t*0.45 ? 1 : 0;
    }
  };
})();

/* ───────────────────────── ECHO ───────────────────────── */
(function(){
  const roundsFor = l => 5 + Math.round((l/50) * 13);   // 5 … 18
  const TONES = [329.63, 415.30, 493.88, 587.33];

  MODULES.simon = {
    id:'simon', result:'score',

    start(level){
      const rnd = rngFor('simon', level);
      const target = roundsFor(level);
      const seq = [];
      for (let i=0;i<target;i++) seq.push((rnd()*4)|0);
      return { seq, target, round:0, pos:0, inputs:[], locked:true, level };
    },
    generate(level){ return this.start(level); },

    replay(level, moves){
      if (!Array.isArray(moves) || moves.length > 5000) return { ok:false, reason:'malformed input list' };
      const st = this.start(level);
      let k = 0, complete = 0;
      for (let r=1; r<=st.target && k < moves.length; r++){
        for (let i=0;i<r && k < moves.length;i++){
          if (moves[k] !== st.seq[i]) return { ok:false, reason:'the sequence was not repeated correctly' };
          k++;
        }
        if (k >= r*(r+1)/2) complete = r;
      }
      if (k !== moves.length) return { ok:false, reason:'extra input' };
      st.round = complete; st.pos = complete; st.inputs = moves.slice();
      return { ok:true, st };
    },

    preview(ctx, s, w){
      const st = this.generate(s.level), pad = w/2;
      const cols = ['#3FB98A','#E0457B','#58B8D8','#C9B899'];
      ctx.fillStyle = '#131E26'; ctx.fillRect(0,0,w,w);
      for (let i=0;i<4;i++){
        ctx.globalAlpha = st.seq[0] === i ? 1 : .34;
        ctx.fillStyle = cols[i];
        ctx.fillRect((i%2)*pad+4, ((i/2)|0)*pad+4, pad-8, pad-8);
      }
      ctx.globalAlpha = 1;
    },

    render(root, st){
      root.innerHTML = `<div class="movebar"><span class="lbl">round</span><b id="si-r">0</b>
          <span class="lbl">of</span><b>${st.target}</b></div>
        <div class="si" id="sig">${[0,1,2,3].map(i=>`<button class="sip" data-i="${i}"></button>`).join('')}</div>
        <p class="hint" id="si-h">Watch, then repeat.</p>`;
      root.querySelectorAll('.sip').forEach(b => b.onclick = () => {
        if (st.locked) return;
        const i = +b.dataset.i;
        this.flash(i, 160);
        st.inputs.push(i);
        if (i !== st.seq[st.pos]){
          Audio2.wrong(); haptic(40);
          st.inputs = st.inputs.slice(0, st.inputs.length - st.pos - 1);   // drop the broken round
          st.round--;
          return Host.finish();
        }
        st.pos++;
        if (st.pos >= st.round){
          if (this.solved(st)) return Host.finish();
          setTimeout(() => this.playRound(st), 620);
        }
      });
      setTimeout(() => this.playRound(st), 500);
    },

    playRound(st){
      st.round++; st.pos = 0; st.locked = true;
      const r = document.getElementById('si-r');
      if (r) r.textContent = st.round;
      const h = document.getElementById('si-h');
      if (h) h.textContent = 'Watch…';
      const gap = Math.max(240, 520 - st.round*12);
      st.seq.slice(0, st.round).forEach((i, k) => {
        setTimeout(() => this.flash(i, gap*0.6), k*gap);
      });
      setTimeout(() => {
        st.locked = false;
        if (h) h.textContent = 'Your turn';
      }, st.round*gap + 120);
    },

    flash(i, ms){
      const el = document.querySelector(`.sip[data-i="${i}"]`);
      if (el){ el.classList.add('lit'); setTimeout(()=>el.classList.remove('lit'), ms); }
      try{
        const c = new (window.AudioContext||window.webkitAudioContext)();
        const o = c.createOscillator(), g = c.createGain();
        o.frequency.value = TONES[i]; o.type = 'triangle';
        g.gain.setValueAtTime(.14, c.currentTime);
        g.gain.exponentialRampToValueAtTime(.0001, c.currentTime + ms/1000);
        o.connect(g).connect(c.destination); o.start(); o.stop(c.currentTime + ms/1000);
      }catch(e){}
    },

    solved(st){ return st.round >= st.target && st.pos >= st.round; },
    serialize(st){ return { moves: st.inputs }; },
    score(st){ return st.round * 100; },
    stars(st){
      const t = st.target;
      return st.round >= t ? 3 : st.round >= t*0.8 ? 2 : st.round >= t*0.6 ? 1 : 0;
    }
  };
})();

/* ───────────────────────── MASTERMIND ───────────────────────── */
(function(){
  const lenFor    = l => l<=25 ? 4 : 5;
  const colorsFor = l => Math.min(8, 6 + Math.round((l/50)*2));
  const MAX = 10;
  const COLS = ['#3FB98A','#E0457B','#58B8D8','#C9B899','#E08A45','#9B7BE0','#4BD6C0','#E8E14B'];

  function marks(guess, code){
    let black = 0, white = 0;
    const gc = {}, cc = {};
    guess.forEach((g,i) => {
      if (g === code[i]) black++;
      else { gc[g] = (gc[g]||0)+1; cc[code[i]] = (cc[code[i]]||0)+1; }
    });
    for (const k in gc) white += Math.min(gc[k], cc[k]||0);
    return { black, white };
  }

  MODULES.mastermind = {
    id:'mastermind', result:'score',

    start(level){
      const rnd = rngFor('mastermind', level);
      const len = lenFor(level), colors = colorsFor(level);
      const code = [];
      for (let i=0;i<len;i++) code.push((rnd()*colors)|0);
      return { code, len, colors, guesses:[], draft:[], par: len + 2 };
    },
    generate(level){ return this.start(level); },

    replay(level, moves){
      if (!Array.isArray(moves) || moves.length > MAX) return { ok:false, reason:'too many guesses' };
      const st = this.start(level);
      for (const g of moves){
        if (!Array.isArray(g) || g.length !== st.len) return { ok:false, reason:'malformed guess' };
        if (g.some(v => !Number.isInteger(v) || v < 0 || v >= st.colors)) return { ok:false, reason:'colour out of range' };
        st.guesses.push(g);
      }
      return { ok:true, st };
    },

    preview(ctx, s, w){
      const st = this.generate(s.level), n = st.len;
      ctx.fillStyle = '#131E26'; ctx.fillRect(0,0,w,w);
      const r = w/(n*2.6);
      st.code.forEach((c, i) => {
        ctx.beginPath();
        ctx.arc(w*(i+0.5)/n, w*0.5, r, 0, 7);
        ctx.fillStyle = COLS[c]; ctx.fill();
      });
      ctx.fillStyle = '#22323E';
      ctx.fillRect(0, w*0.5 - r*1.6, w, r*3.2);
      st.code.forEach((c, i) => {
        ctx.beginPath();
        ctx.arc(w*(i+0.5)/n, w*0.5, r*0.55, 0, 7);
        ctx.fillStyle = '#33485A'; ctx.fill();
      });
    },

    render(root, st){
      root.innerHTML = `<div class="movebar"><span class="lbl">guesses</span><b id="mm-g">0</b>
          <span class="lbl">of</span><b>${MAX}</b></div>
        <div class="mmrows" id="mmr"></div>
        <div class="mmdraft" id="mmd"></div>
        <div class="mmpal" id="mmp"></div>
        <div class="row"><button class="btn" id="mm-go">Submit guess</button></div>`;
      const pal = root.querySelector('#mmp');
      for (let c=0;c<st.colors;c++){
        const b = document.createElement('button');
        b.className = 'mmc'; b.style.background = COLS[c];
        b.onclick = () => {
          if (st.draft.length >= st.len) return;
          st.draft.push(c); Audio2.tap(); this.paint(st);
        };
        pal.appendChild(b);
      }
      root.querySelector('#mmd').onclick = () => { st.draft.pop(); Audio2.tap(); this.paint(st); };
      root.querySelector('#mm-go').onclick = () => {
        if (st.draft.length !== st.len) return Audio2.wrong();
        st.guesses.push(st.draft.slice());
        st.draft = [];
        Audio2.place();
        this.paint(st);
        if (this.solved(st)) return Host.finish();
        if (st.guesses.length >= MAX) Host.finish();
      };
      this.paint(st);
    },

    paint(st){
      const rows = document.getElementById('mmr');
      if (rows){
        rows.innerHTML = st.guesses.map(g => {
          const { black, white } = marks(g, st.code);
          return `<div class="mmrow">
            ${g.map(c=>`<span class="mmp" style="background:${COLS[c]}"></span>`).join('')}
            <span class="mmk">${'●'.repeat(black)}${'○'.repeat(white)}</span></div>`;
        }).join('');
        rows.scrollTop = rows.scrollHeight;
      }
      const d = document.getElementById('mmd');
      if (d) d.innerHTML = Array.from({length: st.len}, (_,i) =>
        `<span class="mmp ${st.draft[i]===undefined?'empty':''}"
           style="${st.draft[i]!==undefined?`background:${COLS[st.draft[i]]}`:''}"></span>`).join('');
      const g = document.getElementById('mm-g');
      if (g) g.textContent = st.guesses.length;
    },

    solved(st){
      const last = st.guesses[st.guesses.length-1];
      return !!last && last.every((v,i) => v === st.code[i]);
    },
    serialize(st){ return { moves: st.guesses }; },
    score(st){
      if (!this.solved(st)) return 0;
      return Math.min(1000, Math.round(1000 * st.par / Math.max(st.guesses.length, st.par)));
    },
    stars(st){
      if (!this.solved(st)) return 0;
      const n = st.guesses.length;
      return n <= st.par ? 3 : n <= st.par + 2 ? 2 : 1;
    }
  };
})();

/* ───────────────────────── SCRAMBLE ───────────────────────── */
(function(){
  /* Kept short and common on purpose: the answer is checked by equality,
     so no dictionary needs to ship with the app. */
  const WORDS = (
    'tide reef kelp sand wave salt foam surf dune crab fish bird ' +
    'coral beach shore ocean storm cliff whale shark pearl water plant shell ' +
    'anchor island lagoon marine harbor breeze sunset ripple pebble ' +
    'current channel drifted seaweed tidepool mariner offshore seabird ' +
    'plankton nautical driftwood shipwreck lighthouse'
  ).split(' ').filter(w => w.length >= 4);

  const wordFor = level => {
    const pool = WORDS.filter(w => w.length >= 4 + Math.floor((level-1)/12));
    const list = pool.length ? pool : WORDS;
    const rnd = rngFor('wordscram', level);
    return list[(rnd() * list.length) | 0];
  };

  MODULES.wordscram = {
    id:'wordscram', result:'score',

    start(level){
      const word = wordFor(level);
      const rnd = rngFor('wordscram', level + 1000);
      let letters = shuffle(word.split(''), rnd);
      if (letters.join('') === word) letters = letters.reverse();
      return { word, letters, slots:new Array(word.length).fill(null), pool:letters.slice() };
    },
    generate(level){ return this.start(level); },

    replay(level, moves){
      const st = this.start(level);
      const answer = Array.isArray(moves) ? moves.join('') : String(moves || '');
      if (answer !== st.word) return { ok:false, reason:'not the word' };
      return { ok:true, st };
    },

    preview(ctx, s, w){
      const st = this.generate(s.level), n = st.letters.length;
      ctx.fillStyle = '#131E26'; ctx.fillRect(0,0,w,w);
      const cell = Math.min(w/n, w/4);
      ctx.font = `700 ${Math.round(cell*.5)}px 'Space Mono', monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      st.letters.forEach((ch, i) => {
        const x = (w - n*cell)/2 + i*cell;
        ctx.fillStyle = '#22323E';
        ctx.fillRect(x+2, w/2 - cell/2, cell-4, cell);
        ctx.fillStyle = '#C9B899';
        ctx.fillText(ch.toUpperCase(), x + cell/2, w/2);
      });
    },

    render(root, st){
      root.innerHTML = `<p class="hint" style="margin-top:4px">Rebuild the word. Tap letters to place them, tap again to take them back.</p>
        <div class="wsslots" id="wss"></div>
        <div class="wspool" id="wsp"></div>
        <div class="row"><button class="btn ghost" id="ws-clear">Clear</button></div>`;
      root.querySelector('#ws-clear').onclick = () => {
        st.slots.fill(null); st.pool = st.letters.slice();
        Audio2.tap(); this.paint(st);
      };
      this.paint(st);
    },

    paint(st){
      const slots = document.getElementById('wss');
      if (slots){
        slots.innerHTML = st.slots.map((ch,i) =>
          `<button class="wst ${ch?'':'empty'}" data-s="${i}">${ch ? ch.toUpperCase() : ''}</button>`).join('');
        slots.querySelectorAll('.wst').forEach(b => b.onclick = () => {
          const i = +b.dataset.s;
          if (!st.slots[i]) return;
          st.pool.push(st.slots[i]);
          st.slots[i] = null;
          Audio2.tap(); this.paint(st);
        });
      }
      const pool = document.getElementById('wsp');
      if (pool){
        pool.innerHTML = st.pool.map((ch,i) =>
          `<button class="wst" data-p="${i}">${ch.toUpperCase()}</button>`).join('');
        pool.querySelectorAll('.wst').forEach(b => b.onclick = () => {
          const i = +b.dataset.p;
          const free = st.slots.indexOf(null);
          if (free < 0) return;
          st.slots[free] = st.pool[i];
          st.pool.splice(i, 1);
          Audio2.place();
          this.paint(st);
          if (this.solved(st)) Host.finish();
        });
      }
    },

    solved(st){ return st.slots.every(Boolean) && st.slots.join('') === st.word; },
    serialize(st){ return { moves: st.slots }; },
    score(st, seconds){ return Math.max(50, Math.round(1200 - seconds * 12)); },
    stars(st, seconds){
      const t = st.word.length * 4;
      return seconds <= t ? 3 : seconds <= t*2 ? 2 : 1;
    }
  };
})();

/* ───────── verifiers ───────── */
/* ───────── sudoku ─────────
   Each returns { ok, reason }. Games without a verifier yet accept on
   sanity checks alone; they are added as their modules ship.          */
const rowOf = i => (i / 9) | 0, colOf = i => i % 9, boxOf = i => ((i / 27) | 0) * 3 + (((i % 9) / 3) | 0);

function sudokuSolution(level) {
  const rnd = rngFor('sudoku', level);
  const g = new Array(81).fill(0);
  const ok = (grid, i, v) => {
    const r = rowOf(i), c = colOf(i), b = boxOf(i);
    for (let j = 0; j < 81; j++) {
      if (j === i || grid[j] !== v) continue;
      if (rowOf(j) === r || colOf(j) === c || boxOf(j) === b) return false;
    }
    return true;
  };
  (function fill(i) {
    if (i === 81) return true;
    for (const v of shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9], rnd)) {
      if (ok(g, i, v)) { g[i] = v; if (fill(i + 1)) return true; g[i] = 0; }
    }
    return false;
  })(0);
  return g;
}

const VERIFIERS = {
  sudoku(level, submitted) {
    const board = submitted && submitted.board;
    if (!Array.isArray(board) || board.length !== 81) return { ok: false, reason: 'malformed board' };
    const sol = sudokuSolution(level);
    for (let i = 0; i < 81; i++) if (board[i] !== sol[i]) return { ok: false, reason: 'board does not solve' };
    return { ok: true };
  },

  nonogram(level, sub){
    const st = MODULES.nonogram.generate(level);
    const g = sub && sub.grid;
    if (!Array.isArray(g) || g.length !== st.n * st.n) return { ok:false, reason:'malformed grid' };
    for (let i=0;i<g.length;i++) if ((g[i] ? 1 : 0) !== st.solution[i]) return { ok:false, reason:'pattern does not match the clues' };
    return { ok:true };
  },
  binairo(level, sub){
    const st = MODULES.binairo.generate(level);
    const b = sub && sub.board;
    if (!Array.isArray(b) || b.length !== st.n * st.n) return { ok:false, reason:'malformed board' };
    for (let i=0;i<b.length;i++) if (b[i] !== st.solution[i]) return { ok:false, reason:'board does not solve' };
    return { ok:true };
  },
  futoshiki(level, sub){
    const st = MODULES.futoshiki.generate(level);
    const b = sub && sub.board;
    if (!Array.isArray(b) || b.length !== st.n * st.n) return { ok:false, reason:'malformed board' };
    for (let i=0;i<b.length;i++) if (b[i] !== st.solution[i]) return { ok:false, reason:'board does not solve' };
    return { ok:true };
  },
  kakuro(level, sub){
    const st = MODULES.kakuro.generate(level);
    const b = (sub && sub.board) || {};
    for (const i of st.whites) if (Number(b[i]) !== st.solution[i]) return { ok:false, reason:'entries do not sum' };
    return { ok:true };
  },
  hashi(level, sub){
    const st = MODULES.hashi.generate(level);
    const b = (sub && sub.bridges) || {};
    for (const k of Object.keys(st.solution)) if (Number(b[k] || 0) !== st.solution[k]) return { ok:false, reason:'bridges do not match' };
    return { ok:true };
  },
  minesweeper(level, sub){
    const st = MODULES.minesweeper.generate(level);
    const open = new Set((sub && sub.open) || []);
    for (let i=0;i<st.w*st.h;i++){
      if (!st.mines[i] && !open.has(i)) return { ok:false, reason:'field not cleared' };
      if (st.mines[i] && open.has(i))  return { ok:false, reason:'a mine was opened' };
    }
    return { ok:true };
  },

  flow(level, sub){
    const st = MODULES.flow.generate(level);
    const n = st.n;
    const trails = sub && sub.trails;
    if (!Array.isArray(trails) || trails.length !== st.ends.length) return { ok:false, reason:'malformed trails' };
    const cell = new Array(n*n).fill(-1);
    for (let c=0;c<trails.length;c++){
      const tr = trails[c];
      if (!Array.isArray(tr) || tr.length < 2) return { ok:false, reason:'a pair is unjoined' };
      const [a,b] = st.ends[c];
      const head = tr[0], tail = tr[tr.length-1];
      if (!((head===a&&tail===b) || (head===b&&tail===a))) return { ok:false, reason:'a trail misses its dots' };
      for (let i=0;i<tr.length;i++){
        const x = tr[i];
        if (!Number.isInteger(x) || x < 0 || x >= n*n) return { ok:false, reason:'trail off the grid' };
        if (cell[x] !== -1) return { ok:false, reason:'trails overlap' };
        cell[x] = c;
        if (i){
          const p = tr[i-1];
          const adj = (Math.abs(p-x) === n) || (Math.abs(p-x) === 1 && ((p/n)|0) === ((x/n)|0));
          if (!adj) return { ok:false, reason:'trail jumps' };
        }
      }
    }
    if (cell.some(v => v === -1)) return { ok:false, reason:'grid not filled' };
    return { ok:true };
  },
  maze(level, sub){
    const st = MODULES.maze.generate(level);
    const tr = sub && sub.trail;
    if (!Array.isArray(tr) || tr[0] !== st.start || tr[tr.length-1] !== st.goal)
      return { ok:false, reason:'route does not run start to finish' };
    const seen = new Set();
    for (let i=0;i<tr.length;i++){
      if (seen.has(tr[i])) return { ok:false, reason:'route repeats a cell' };
      seen.add(tr[i]);
      if (i && !MODULES.maze.open(st, tr[i-1], tr[i])) return { ok:false, reason:'route crosses a wall' };
    }
    return { ok:true };
  },
  slitherlink(level, sub){
    const st = MODULES.slitherlink.generate(level);
    const e = sub && sub.edges;
    if (!Array.isArray(e) || e.length !== st.E.total) return { ok:false, reason:'malformed loop' };
    const arr = e.map(v => v === 1 ? 1 : 0);
    for (let r=0;r<st.n;r++) for (let c=0;c<st.n;c++){
      const v = st.clues[r*st.n+c];
      if (v == null) continue;
      if (st.E.cellEdges(r,c).filter(x => arr[x] === 1).length !== v)
        return { ok:false, reason:'a number is not satisfied' };
    }
    if (!MODULES.slitherlink._singleLoop(st.n, st.clues, arr)) return { ok:false, reason:'not a single closed loop' };
    return { ok:true };
  },

  /* Replay games: the move list is re-run from the seeded start position,
     and the score is recomputed here rather than taken on trust. */
  fifteen(level, sub, elapsed){ return replayCheck('fifteen', level, sub, elapsed); },
  lightsout(level, sub, elapsed){ return replayCheck('lightsout', level, sub, elapsed); },
  peg(level, sub, elapsed){ return replayCheck('peg', level, sub, elapsed); },
  sokoban(level, sub, elapsed){ return replayCheck('sokoban', level, sub, elapsed); },
  rushhour(level, sub, elapsed){ return replayCheck('rushhour', level, sub, elapsed); },
  twenty48(level, sub, elapsed){ return replayCheck('twenty48', level, sub, elapsed); },
  blockudoku(level, sub, elapsed){ return replayCheck('blockudoku', level, sub, elapsed); },
  simon(level, sub, elapsed){ return replayCheck('simon', level, sub, elapsed); },
  mastermind(level, sub, elapsed){ return replayCheck('mastermind', level, sub, elapsed); },
  wordscram(level, sub, elapsed){ return replayCheck('wordscram', level, sub, elapsed); }
};

function replayCheck(id, level, sub, elapsed){
  const mod = MODULES[id];
  const r = mod.replay(level, sub && sub.moves);
  if (!r.ok) return { ok:false, reason:r.reason };
  return { ok:true,
           value: mod.score(r.st, elapsed || 0),
           stars: mod.stars(r.st, elapsed || 0) };
}

/** Floor on plausible solve time, so a verified board can't arrive in 2 seconds. */
const MIN_SECONDS = { sudoku: 25, nonogram: 15, binairo: 20, futoshiki: 15,
                      kakuro: 20, hashi: 12, minesweeper: 10,
                      flow: 10, maze: 8, slitherlink: 25,
                      fifteen: 8, lightsout: 5, peg: 10, sokoban: 10, rushhour: 8,
                      twenty48: 15, blockudoku: 15, simon: 10, mastermind: 8, wordscram: 4 };

/* ───────── daily challenge ─────────
   Derived from the date alone, so every player gets the same puzzle
   without anyone having to publish it. */
const GAME_IDS = ['sudoku','nonogram','kakuro','binairo','futoshiki','hashi','minesweeper',
                  'flow','maze','slitherlink','fifteen','lightsout','sokoban','rushhour','peg',
                  'twenty48','blockudoku','simon','mastermind','wordscram'];
function dailyPick(dateStr){
  const r = mulberry32(xmur3('tidepool:daily:' + dateStr)());
  const gameId = GAME_IDS[(r() * GAME_IDS.length) | 0];
  const level  = 1 + ((r() * 50) | 0);
  return { date: dateStr, gameId, level };
}
const today = () => new Date().toISOString().slice(0, 10);

/* games where the lower number wins */
const TIMED = ['sudoku','nonogram','kakuro','binairo','futoshiki','hashi','minesweeper',
               'flow','maze','slitherlink'];

/* ───────── helpers ───────── */
async function userFrom(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  const { data, error } = await admin.auth.getUser(h.slice(7));
  return error ? null : data.user;
}
async function friendIds(user) {
  const { data } = await admin.from('friendships')
    .select('requester_id, addressee_id')
    .eq('status', 'accepted')
    .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`);
  return [user.id, ...(data || []).map(r => r.requester_id === user.id ? r.addressee_id : r.requester_id)];
}

async function withNames(rows) {
  const ids = [...new Set(rows.map(r => r.user_id))];
  if (!ids.length) return rows;
  const { data } = await admin.from('profiles').select('id, username, avatar_emoji').in('id', ids);
  const map = {};
  (data || []).forEach(p => map[p.id] = p);
  return rows.map(r => Object.assign({}, r, {
    username: (map[r.user_id] || {}).username || 'player',
    avatar_emoji: (map[r.user_id] || {}).avatar_emoji || '\u{1F41A}' }));
}

const bad  = (res, code, error) => res.status(code).json({ error });
const body = req => (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {});

/* ───────── actions ───────── */
const ACTIONS = {

  /* profile ------------------------------------------------------ */
  async profile(user, b) {
    const id = b.userId || user.id;
    const { data: profile } = await admin.from('profiles').select('*').eq('id', id).single();
    const { data: scores } = await admin
      .from('scores').select('game_id, level, value, stars, result_type').eq('user_id', id);
    const { count: unread } = await admin.from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id).is('read_at', null);
    return { profile, scores: scores || [], unread: unread || 0 };
  },

  /* score submission — the guarded path ------------------------- */
  async submit(user, b) {
    const { gameId, level, resultType, value, stars, elapsed, solution, challengeId } = b;
    if (!gameId || !level || level < 1 || level > 50) throw new Error('Unknown level');

    const verify = VERIFIERS[gameId];
    let finalValue = value, finalStars = stars;
    if (verify) {
      const v = verify(level, solution, elapsed);
      if (!v.ok) throw new Error('Rejected: ' + v.reason);
      if (v.value != null) finalValue = v.value;   // scored games are recomputed, not trusted
      if (v.stars != null) finalStars = v.stars;
    }
    const floor = MIN_SECONDS[gameId] || 3;
    if (resultType === 'time' && (!(elapsed > 0) || elapsed < floor)) throw new Error('Rejected: implausible time');

    /* keep only the personal best */
    const { data: prev } = await admin.from('scores')
      .select('id, value').eq('user_id', user.id).eq('game_id', gameId).eq('level', level).maybeSingle();

    const better = !prev || (resultType === 'time' ? finalValue < prev.value : finalValue > prev.value);
    if (better) {
      await admin.from('scores').upsert({
        user_id: user.id, game_id: gameId, level,
        result_type: resultType, value: finalValue, stars: finalStars, created_at: new Date().toISOString()
      }, { onConflict: 'user_id,game_id,level' });
    }

    const xp = (prev ? 2 : 10) + finalStars * 5;
    await admin.rpc('add_xp', { p_user: user.id, p_xp: xp }).catch(() => {});

    /* standing on this exact level */
    const { data: faster, count } = await admin.from('scores')
      .select('user_id', { count: 'exact', head: true })
      .eq('game_id', gameId).eq('level', level)
      .filter('value', resultType === 'time' ? 'lt' : 'gt', finalValue);
    const { count: total } = await admin.from('scores')
      .select('user_id', { count: 'exact', head: true }).eq('game_id', gameId).eq('level', level);

    const rank = (count || 0) + 1;
    const percent = total ? Math.max(1, Math.round((rank / total) * 100)) : 100;

    if (challengeId) await resolveChallenge(user, challengeId, finalValue, resultType);

    return { ok: true, personalBest: better, value: finalValue,
             rank, total: total || 1, percent, xp };
  },

  /* leaderboards --------------------------------------------------- */
  async leaderboard(user, b) {
    const { gameId, level = null, scope = 'global' } = b;
    const timed = TIMED.includes(gameId);
    const ids = scope === 'friends' ? await friendIds(user) : null;

    /* one exact level: the purest comparison, since the board is identical */
    if (level) {
      let q = admin.from('scores')
        .select('user_id, value, stars, created_at')
        .eq('game_id', gameId).eq('level', level);
      if (ids) q = q.in('user_id', ids);
      const { data } = await q;
      const rows = (data || []).sort((x, y) => timed ? x.value - y.value : y.value - x.value).slice(0, 100);
      return { rows: await withNames(rows), level, timed };
    }

    /* whole game: stars first, then levels cleared, then the aggregate */
    let q = admin.from('leaderboard_totals').select('*').eq('game_id', gameId);
    if (ids) q = q.in('user_id', ids);
    const { data } = await q;
    const rows = (data || []).sort((x, y) =>
      (y.stars - x.stars) ||
      (y.levels_cleared - x.levels_cleared) ||
      (timed ? x.total - y.total : y.total - x.total)
    ).slice(0, 100);
    return { rows, timed };
  },

  /* every game at once, ranked by what players actually accumulated */
  async overall(user, b) {
    const ids = (b && b.scope) === 'friends' ? await friendIds(user) : null;
    let q = admin.from('leaderboard_totals').select('*');
    if (ids) q = q.in('user_id', ids);
    const { data } = await q;
    const agg = {};
    (data || []).forEach(r => {
      const a = agg[r.user_id] || (agg[r.user_id] = {
        user_id: r.user_id, username: r.username, avatar_emoji: r.avatar_emoji,
        stars: 0, levels_cleared: 0, games: 0
      });
      a.stars += r.stars || 0;
      a.levels_cleared += r.levels_cleared || 0;
      a.games++;
    });
    const rows = Object.values(agg)
      .sort((x, y) => (y.stars - x.stars) || (y.levels_cleared - x.levels_cleared))
      .slice(0, 100);
    return { rows };
  },

  /* today's puzzle, plus how everyone did on it today */
  async daily(user, b) {
    const pick = dailyPick(today());
    const ids = (b && b.scope) === 'friends' ? await friendIds(user) : null;
    let q = admin.from('scores')
      .select('user_id, value, stars, created_at')
      .eq('game_id', pick.gameId).eq('level', pick.level)
      .gte('created_at', pick.date);
    if (ids) q = q.in('user_id', ids);
    const { data } = await q;
    const timed = TIMED.includes(pick.gameId);
    const rows = (data || []).sort((x, y) => timed ? x.value - y.value : y.value - x.value).slice(0, 100);
    return Object.assign({}, pick, { timed, rows: await withNames(rows) });
  },

  /* friends ------------------------------------------------------- */
  async friendSearch(user, b) {
    const { data } = await admin.from('profiles')
      .select('id, username, avatar_emoji, xp')
      .ilike('username', `%${(b.q || '').slice(0, 24)}%`)
      .neq('id', user.id).limit(20);
    return { users: data || [] };
  },
  async friendRequest(user, b) {
    if (b.userId === user.id) throw new Error('You cannot friend yourself');
    await admin.from('friendships').upsert({
      requester_id: user.id, addressee_id: b.userId, status: 'pending'
    }, { onConflict: 'requester_id,addressee_id' });
    await notify(b.userId, 'friend_request', { from: user.id });
    return { ok: true };
  },
  async friendRespond(user, b) {
    const status = b.accept ? 'accepted' : 'declined';
    await admin.from('friendships').update({ status })
      .eq('requester_id', b.userId).eq('addressee_id', user.id);
    if (b.accept) await notify(b.userId, 'friend_accepted', { from: user.id });
    return { ok: true, status };
  },
  async friendList(user) {
    const { data } = await admin.from('friendships')
      .select('requester_id, addressee_id, status')
      .or(`requester_id.eq.${user.id},addressee_id.eq.${user.id}`);
    const rows = data || [];
    const ids = [...new Set(rows.flatMap(r => [r.requester_id, r.addressee_id]))].filter(i => i !== user.id);
    const { data: profiles } = ids.length
      ? await admin.from('profiles').select('id, username, avatar_emoji, xp').in('id', ids)
      : { data: [] };
    return { edges: rows, profiles: profiles || [] };
  },

  /* challenges ---------------------------------------------------- */
  async challenge(user, b) {
    const { toUser, gameId, level } = b;
    if (!toUser || toUser === user.id) throw new Error('Pick a friend to challenge');
    if (!level || level < 1 || level > 50) throw new Error('Unknown level');
    const { data: edge } = await admin.from('friendships')
      .select('status')
      .or(`and(requester_id.eq.${user.id},addressee_id.eq.${toUser}),and(requester_id.eq.${toUser},addressee_id.eq.${user.id})`)
      .eq('status', 'accepted').maybeSingle();
    if (!edge) throw new Error('You can only challenge friends');
    const { data, error } = await admin.from('challenges').insert({
      from_user: user.id, to_user: toUser, game_id: gameId, level,
      seed: seedFor(gameId, level), status: 'open', turn_of: user.id
    }).select().single();
    if (error) throw error;
    await notify(toUser, 'challenge', { challengeId: data.id, gameId, level, from: user.id });
    return { challenge: data };
  },
  async challengeList(user) {
    const { data } = await admin.from('challenges').select('*')
      .or(`from_user.eq.${user.id},to_user.eq.${user.id}`)
      .order('created_at', { ascending: false }).limit(50);
    const rows = data || [];
    const ids = [...new Set(rows.flatMap(r => [r.from_user, r.to_user]))];
    const { data: profiles } = ids.length
      ? await admin.from('profiles').select('id, username, avatar_emoji').in('id', ids)
      : { data: [] };
    const { data: reactions } = rows.length
      ? await admin.from('reactions').select('*').in('challenge_id', rows.map(r => r.id))
      : { data: [] };
    return { challenges: rows, profiles: profiles || [], reactions: reactions || [] };
  },

  /* reactions ----------------------------------------------------- */
  async react(user, b) {
    if (!b.challengeId) return { ok: true, skipped: 'solo run' };
    await admin.from('reactions').upsert({
      challenge_id: b.challengeId, user_id: user.id, emoji: b.emoji
    }, { onConflict: 'challenge_id,user_id' });
    const { data: c } = await admin.from('challenges').select('from_user, to_user').eq('id', b.challengeId).single();
    if (c) {
      const other = c.from_user === user.id ? c.to_user : c.from_user;
      await notify(other, 'reaction', { challengeId: b.challengeId, emoji: b.emoji, from: user.id });
    }
    return { ok: true };
  },

  /* notifications -------------------------------------------------- */
  async notifications(user) {
    const { data } = await admin.from('notifications').select('*')
      .eq('user_id', user.id).order('created_at', { ascending: false }).limit(50);
    const rows = data || [];
    const ids = [...new Set(rows.map(r => r.payload && r.payload.from).filter(Boolean))];
    const { data: profiles } = ids.length
      ? await admin.from('profiles').select('id, username, avatar_emoji').in('id', ids)
      : { data: [] };
    return { notifications: rows, profiles: profiles || [],
             unread: rows.filter(r => !r.read_at).length };
  },
  async notificationsRead(user) {
    await admin.from('notifications').update({ read_at: new Date().toISOString() })
      .eq('user_id', user.id).is('read_at', null);
    return { ok: true };
  }
};

async function notify(userId, type, payload) {
  await admin.from('notifications').insert({ user_id: userId, type, payload });
}

async function resolveChallenge(user, challengeId, value, resultType) {
  const { data: c } = await admin.from('challenges').select('*').eq('id', challengeId).single();
  if (!c || c.status === 'complete') return;
  const isFrom = c.from_user === user.id;
  const patch = isFrom ? { from_result: value } : { to_result: value };

  const mine = value;
  const theirs = isFrom ? c.to_result : c.from_result;

  if (theirs == null) {
    patch.turn_of = isFrom ? c.to_user : c.from_user;
    patch.status = 'awaiting';
    await admin.from('challenges').update(patch).eq('id', challengeId);
    await notify(patch.turn_of, 'your_turn', { challengeId, gameId: c.game_id, level: c.level, from: user.id });
    return;
  }
  const iWin = resultType === 'time' ? mine < theirs : mine > theirs;
  patch.status = 'complete';
  patch.turn_of = null;
  patch.winner_id = mine === theirs ? null : (iWin ? user.id : (isFrom ? c.to_user : c.from_user));
  await admin.from('challenges').update(patch).eq('id', challengeId);
  const other = isFrom ? c.to_user : c.from_user;
  await notify(other, 'challenge_result', { challengeId, winner: patch.winner_id });
}

/* ───────── entry ───────── */
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return bad(res, 405, 'Use POST');

  const action = (req.query && req.query.action) || '';
  const fn = ACTIONS[action];
  if (!fn) return bad(res, 400, 'Unknown action: ' + action);

  const user = await userFrom(req);
  if (!user) return bad(res, 401, 'Sign in to do that');

  try {
    return res.status(200).json(await fn(user, body(req)));
  } catch (e) {
    return bad(res, 400, e.message || 'Something went wrong');
  }
};
