/* script.js
 Age of Conflict × World Map
 Single-file engine for map generation, factions, AI, simulation, UI.
 Author: ChatGPT (deliverable)
 Keep the 3-file structure: index.html, style.css, script.js
*/

// ---- Utilities -----------------------------------------------------------
const rand = (seeded) => {
  let s = seeded || Math.floor(Math.random()*1e9);
  return function() { s = (s * 1664525 + 1013904223) >>> 0; return s / 2**32; };
};
function lerp(a,b,t){return a + (b-a)*t}
function clamp(v,a,b){return Math.max(a,Math.min(b,v))}
function hex(col){ return '#' + col.map(c=>c.toString(16).padStart(2,'0')).join(''); }
function pick(arr, rnd){ return arr[Math.floor(rnd()*arr.length)]; }

// ---- Config / State -----------------------------------------------------
const config = {
  seed: Math.floor(Math.random()*1e9),
  mapW: 160, mapH: 92, // grid tiles
  tileSize: 8,
  factionsCount: 6,
  initialSettlements: 8,
  maxTurns: 2000
};
let state = {
  rng: null,
  map: null,            // 2D array of tiles
  regions: [],          // territories regions
  factions: [],         // factions
  turn: 0,
  eraIndex: 0,
  selected: null,
  autoPlay: false,
  editMode: false,
  animQueue: []
};

// ---- Noise / Heightmap (value noise + fBM) ------------------------------
function valueNoise(w,h,seed){
  const rnd = rand(seed);
  const grid = new Array(w+1);
  for(let x=0;x<=w;x++){ grid[x]=new Array(h+1).fill(0).map(()=>rnd()); }
  return function(u,v){
    const x = Math.floor(u*(w-1)), y = Math.floor(v*(h-1));
    const fx = u*(w-1)-x, fy = v*(h-1)-y;
    const a = grid[x][y], b = grid[x+1][y], c = grid[x][y+1], d = grid[x+1][y+1];
    const ix1 = lerp(a,b,fx), ix2 = lerp(c,d,fx);
    return lerp(ix1, ix2, fy);
  };
}
function makeHeightmap(width,height,seed){
  const base = valueNoise(32,32,seed);
  const octaves = 5;
  return (x,y)=>{
    const nx = x/width, ny = y/height;
    let amp = 1, freq = 1, sum=0, norm=0;
    for(let o=0;o<octaves;o++){
      sum += amp * base((nx*freq)%1, (ny*freq)%1);
      norm += amp; amp *= 0.5; freq *= 2;
    }
    return sum / norm;
  };
}

// ---- Map Tile generation -------------------------------------------------
function generateMap(seed){
  state.rng = rand(seed);
  const {mapW,mapH} = config;
  const hm = makeHeightmap(mapW,mapH, seed ^ 0xA5A5A5A5);
  const tiles = new Array(mapH);
  for(let y=0;y<mapH;y++){
    tiles[y]=new Array(mapW);
    for(let x=0;x<mapW;x++){
      const h = hm(x,y);
      // Add equator bias
      const lat = Math.abs((y/mapH)-0.5)*2;
      const finalH = h * (1 - 0.35*lat);
      tiles[y][x] = {
        x,y,
        height: finalH,
        water: finalH < 0.45,
        mountain: finalH > 0.82,
        region: null,
        unit: null,
        city: null,
        sight: {}
      };
    }
  }
  // Simple rivers: follow steepness
  for(let i=0;i<Math.floor(mapW*mapH*0.002);i++){
    let rx = Math.floor(state.rng()*mapW), ry = Math.floor(state.rng()*mapH);
    for(let s=0;s<200;s++){
      const t = tiles[ry][rx];
      t.water = t.water || t.height < 0.52;
      // descend
      let best = {x:rx,y:ry,h:t.height};
      for(let oy=-1;oy<=1;oy++) for(let ox=-1;ox<=1;ox++){
        const nx=rx+ox, ny=ry+oy;
        if(nx>=0 && ny>=0 && nx<mapW && ny<mapH){
          if(tiles[ny][nx].height < best.h){ best = {x:nx,y:ny,h:tiles[ny][nx].height}; }
        }
      }
      if(best.x===rx && best.y===ry) break;
      rx = best.x; ry = best.y;
      tiles[ry][rx].water = true;
    }
  }
  return tiles;
}

// ---- Region / Territory generation (seeded Voronoi-ish) -----------------
function generateRegions(tiles,seed,regionCount=60){
  const w = tiles[0].length, h = tiles.length;
  const rnd = rand(seed ^ 0xC0FFEE);
  const seeds = [];
  for(let i=0;i<regionCount;i++){
    seeds.push({x:Math.floor(rnd()*w), y:Math.floor(rnd()*h), id:i});
  }
  // Simple nearest-seed assignment
  const regions = seeds.map(s=>({id:s.id,seeds:[s],tiles:[],owner:null}));

  for(let y=0;y<h;y++) for(let x=0;x<w;x++){
    const tile = tiles[y][x];
    let best = null, bestd=1e9;
    for(const s of seeds){
      const dx=x-s.x, dy=y-s.y;
      const d = dx*dx+dy*dy;
      if(d<bestd){ bestd=d; best=s; }
    }
    tile.region = best.id;
    regions[best.id].tiles.push(tile);
  }
  // Merge tiny regions
  const minSize = Math.max(20, Math.floor((w*h)/200));
  for(const r of regions.slice()){
    if(r.tiles.length < minSize){
      // attach to neighbor region of adjacent tile
      const t = r.tiles[0];
      let neighborRegion = null;
      for(let oy=-2;oy<=2;oy++) for(let ox=-2;ox<=2;ox++){
        const nx=t.x+ox, ny=t.y+oy;
        if(nx>=0 && ny>=0 && nx<w && ny<h){
          neighborRegion = tiles[ny][nx].region;
          if(neighborRegion !== r.id) break;
        }
      }
      if(neighborRegion!=null){
        // move all tiles to neighbor
        for(const tile of r.tiles){
          tile.region = neighborRegion;
          regions[neighborRegion].tiles.push(tile);
        }
        // remove r
        regions[r.id].tiles = [];
      }
    }
  }

  // compact region list
  const compact = [];
  const mapOldToNew = {};
  let nid=0;
  for(const r of regions){
    if(r.tiles.length>0){
      mapOldToNew[r.id]=nid;
      r.id=nid;
      compact.push(r);
      nid++;
    }
  }
  for(const r of compact) for(const t of r.tiles) t.region=r.id;
  return compact;
}

// ---- Factions & Units ---------------------------------------------------
const UNIT_TYPES = {
  scout:{name:'Scout', move:4, atk:1, def:0.5, sight:6, cost:10},
  infantry:{name:'Infantry', move:2, atk:3, def:2, sight:4, cost:25},
  cavalry:{name:'Cavalry', move:4, atk:4, def:2.5, sight:5, cost:40},
  siege:{name:'Siege', move:1, atk:7, def:1, sight:3, cost:70}
};
function createFactions(n,regions,seed){
  const rnd = rand(seed ^ 0x123456);
  const colors = [];
  for(let i=0;i<n;i++){
    colors.push([Math.floor(80 + rnd()*160), Math.floor(80 + rnd()*160), Math.floor(80 + rnd()*160)]);
  }
  const factions = [];
  // pick capitals on fertile, non-water regions
  const candidateRegions = regions.filter(r=>r.tiles.some(t=>!t.water && !t.mountain));
  for(let i=0;i<n;i++){
    const r = pick(candidateRegions, rnd);
    const tile = pick(r.tiles, rnd);
    const f = {
      id:i, name:`Faction ${i+1}`, color:colors[i], capital:tile, regions:[r.id], units:[], expansionAggro:1 + rnd()*2,
      treasury:200 + Math.floor(rnd()*200), tech:0
    };
    factions.push(f);
  }
  // assign ownership to those regions near capitals
  for(const f of factions){
    for(const r of regions){
      // compute centroid distance to capital
      const center = r.tiles[Math.floor(r.tiles.length * rnd())];
      const dx = center.x - f.capital.x, dy = center.y - f.capital.y;
      const d2 = dx*dx + dy*dy;
      if(d2 < (config.mapW*config.mapH / (factions.length*2))) {
        r.owner = f.id;
        if(!f.regions.includes(r.id)) f.regions.push(r.id);
      }
    }
    // place initial units in capital region
    placeCityAndUnits(f.capital, f, 'capital');
  }
  return factions;
}
function placeCityAndUnits(tile,faction,type='city'){
  tile.city = {owner: faction.id, name: (type==='capital' ? faction.name+' Capital' : 'City'), garrison:[]};
  // create a small garrison
  const rnd = state.rng;
  const ucount = 2 + Math.floor(rnd()*3);
  for(let i=0;i<ucount;i++){
    const t = pick(Object.values(UNIT_TYPES), rnd);
    const unit = {
      id: 'u' + Math.floor(rnd()*1e9),
      type: t,
      hp: 10,
      owner: faction.id,
      x: tile.x, y: tile.y,
      movesLeft: t.move
    };
    faction.units.push(unit);
    tile.unit = unit; // one per tile (others will be placed nearby)
  }
}

// ---- Fog of War / Vision ------------------------------------------------
function computeVision(){
  // reset sight
  for(const r of state.map.flat()) r.sight = {};
  for(const f of state.factions){
    for(const u of f.units){
      const range = u.type.sight + Math.floor(state.eraIndex*1);
      for(let oy=-range;oy<=range;oy++) for(let ox=-range;ox<=range;ox++){
        const nx = u.x + ox, ny = u.y + oy;
        if(nx>=0 && ny>=0 && nx<config.mapW && ny<config.mapH){
          const t = state.map[ny][nx];
          t.sight[f.id] = true;
        }
      }
    }
    // cities also give limited sight
    for(const rId of f.regions){
      // nothing fancy
    }
  }
}

// ---- Game Engine: turn, AI, combat -------------------------------------
function advanceTurn(){
  state.turn++;
  // era progression every 25 turns
  state.eraIndex = Math.floor(state.turn / 25);
  state.eraIndex = clamp(state.eraIndex, 0, 3);
  // each faction acts
  for(const f of state.factions){
    aiTakeTurn(f);
  }
  // move animation tasks (resolve queued)
  computeVision();
  render();
  updateUI();
}

function aiTakeTurn(faction){
  const rnd = state.rng;
  // simple behavior: expand by producing one unit or taking adjacent regions
  faction.treasury += Math.floor(5 + faction.regions.length*2);
  // build unit sometimes
  if(faction.treasury > 50 && rnd() < 0.5){
    faction.treasury -= 30;
    // spawn near capital
    const cap = faction.capital;
    const tile = findNearbyEmptyTile(cap.x,cap.y,6);
    if(tile){
      const unitType = pick([UNIT_TYPES.infantry, UNIT_TYPES.scout, UNIT_TYPES.cavalry], rnd);
      const unit = {id:'u'+Math.floor(rnd()*1e9), type:unitType, hp:10, owner:faction.id, x:tile.x,y:tile.y, movesLeft:unitType.move};
      faction.units.push(unit);
      tile.unit = unit;
    }
  }
  // try to attack neighboring regions randomly
  if(rnd() < 0.6){
    for(const unit of faction.units){
      if(rnd() < 0.25) continue;
      const target = findNearestEnemyRegion(unit.x, unit.y, faction.id);
      if(target){
        // move toward random tile in target region
        const destTile = pick(target.tiles, rnd);
        moveUnitToward(unit, destTile.x, destTile.y);
      } else {
        // maybe roam
        const nx = clamp(unit.x + Math.floor((rnd()*2-1)*3), 0, config.mapW-1);
        const ny = clamp(unit.y + Math.floor((rnd()*2-1)*3), 0, config.mapH-1);
        moveUnitToward(unit, nx, ny);
      }
    }
  }
}

function findNearestEnemyRegion(x,y,ownerId){
  let best=null, bestD=1e9;
  for(const r of state.regions){
    if(r.id==null || r.tiles.length==0) continue;
    if(r.owner===undefined || r.owner===ownerId) continue;
    // compute centroid
    const t = r.tiles[Math.floor(r.tiles.length/2)];
    const dx=t.x-x, dy=t.y-y;
    const d=dx*dx+dy*dy;
    if(d<bestD){bestD=d;best=r;}
  }
  return best;
}

function findNearbyEmptyTile(x,y,radius){
  for(let r=0;r<radius;r++){
    for(let oy=-r;oy<=r;oy++) for(let ox=-r;ox<=r;ox++){
      const nx=x+ox, ny=y+oy;
      if(nx>=0 && ny>=0 && nx<config.mapW && ny<config.mapH){
        const t=state.map[ny][nx];
        if(!t.unit && !t.water && !t.mountain) return t;
      }
    }
  }
  return null;
}

function moveUnitToward(unit, tx, ty){
  // simple greedy step
  const dx = Math.sign(tx - unit.x), dy = Math.sign(ty - unit.y);
  const nx = clamp(unit.x + dx, 0, config.mapW-1), ny = clamp(unit.y + dy, 0, config.mapH-1);
  const dest = state.map[ny][nx];
  if(dest.unit && dest.unit.owner !== unit.owner){
    // combat
    resolveCombat(unit, dest.unit);
  } else if(!dest.unit){
    // move
    const cur = state.map[unit.y][unit.x];
    if(cur.unit === unit) cur.unit = null;
    unit.x = nx; unit.y = ny;
    dest.unit = unit;
    // capture region if applicable
    if(dest.region!=null){
      const region = state.regions[dest.region];
      if(region.owner !== unit.owner){
        // small chance to change ownership after repeated visits
        if(Math.random() < 0.02 + state.turn/1000){
          region.owner = unit.owner;
          const fac = state.factions[unit.owner];
          if(!fac.regions.includes(region.id)) fac.regions.push(region.id);
        }
      }
    }
  }
}

function resolveCombat(attacker, defender){
  const atk = attacker.type.atk + (state.eraIndex*0.5);
  const def = defender.type.def + (state.eraIndex*0.3);
  const roll = Math.random();
  const atkPower = atk * (0.6 + Math.random()*0.8);
  const defPower = def * (0.6 + Math.random()*0.8);
  if(atkPower > defPower){
    // attacker wins, remove defender
    const defOwner = state.factions[defender.owner];
    defOwner.units = defOwner.units.filter(u=>u!==defender);
    const tile = state.map[defender.y][defender.x];
    tile.unit = attacker;
    attacker.x = tile.x; attacker.y = tile.y;
    // attacker may occupy
  } else {
    // defender survives
    const atkOwner = state.factions[attacker.owner];
    atkOwner.units = atkOwner.units.filter(u=>u!==attacker);
    const tile = state.map[attacker.y][attacker.x];
    if(tile.unit === attacker) tile.unit = null;
  }
}

// ---- Rendering -----------------------------------------------------------
const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
canvas.width = config.mapW * config.tileSize;
canvas.height = config.mapH * config.tileSize;
const minimapEl = document.getElementById('minimap');
function render(){
  const ts = config.tileSize;
  ctx.clearRect(0,0,canvas.width,canvas.height);
  // draw tiles
  for(let y=0;y<config.mapH;y++){
    for(let x=0;x<config.mapW;x++){
      const t = state.map[y][x];
      const px = x*ts, py = y*ts;

      // Determine base color
      let color;
      if(t.water) {
        const shade = Math.floor(20 + t.height*80);
        color = `rgb(${10+shade},${30+shade},${90+shade})`;
      } else if(t.mountain) {
        const m = Math.floor(150 + (t.height-0.82)*400);
        color = `rgb(${m},${m-20},${m-40})`;
      } else {
        // biome by height
        const g = Math.floor(80 + t.height*120);
        color = `rgb(${40+g},${80+g},${40})`;
      }
      ctx.fillStyle = color;
      ctx.fillRect(px,py,ts,ts);

      // region borders subtle
      if(t.region!=null){
        const region = state.regions[t.region];
        if(region && region.owner!=null){
          const col = state.factions[region.owner].color;
          ctx.globalAlpha = 0.06;
          ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},0.08)`;
          ctx.fillRect(px,py,ts,ts);
          ctx.globalAlpha = 1;
        }
      }
      // mountain highlight
      if(t.mountain){
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(px,py,ts,ts);
      }
    }
  }

  // draw grid faint
  ctx.strokeStyle = 'rgba(0,0,0,0.06)';
  ctx.lineWidth = 0.6;
  for(let x=0;x<=config.mapW;x++){
    ctx.beginPath(); ctx.moveTo(x*ts,0); ctx.lineTo(x*ts, canvas.height); ctx.stroke();
  }
  for(let y=0;y<=config.mapH;y++){
    ctx.beginPath(); ctx.moveTo(0,y*ts); ctx.lineTo(canvas.width, y*ts); ctx.stroke();
  }

  // draw cities & units
  for(const f of state.factions){
    for(const u of f.units){
      const px = u.x*ts + ts*0.5, py = u.y*ts + ts*0.5;
      ctx.beginPath();
      ctx.arc(px,py, Math.max(2, ts*0.35), 0, Math.PI*2);
      ctx.fillStyle = `rgb(${f.color[0]},${f.color[1]},${f.color[2]})`;
      ctx.fill();
      // unit symbol
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.font = `${Math.max(8, ts*0.5)}px serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(u.type.name[0], px, py);
    }
    // cities
    for(const rId of f.regions){
      const r = state.regions[rId];
      if(!r) continue;
      // draw capital marker if within region and exists
    }
  }

  // selection highlight
  if(state.selected){
    const s = state.selected;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.strokeRect(s.x*ts+1,s.y*ts+1,ts-2,ts-2);
  }

  // minimap tiny render
  drawMinimap();
}

function drawMinimap(){
  // render a small pixel map into minimapEl using canvas
  let mm = minimapEl.querySelector('canvas');
  if(!mm){
    mm = document.createElement('canvas'); mm.width = config.mapW; mm.height = config.mapH;
    minimapEl.innerHTML = ''; minimapEl.appendChild(mm);
  }
  const mctx = mm.getContext('2d');
  const img = mctx.createImageData(config.mapW, config.mapH);
  let idx=0;
  for(let y=0;y<config.mapH;y++) for(let x=0;x<config.mapW;x++){
    const t=state.map[y][x];
    let r,g,b;
    if(t.water){ r=20; g=40; b=120; }
    else if(t.mountain){ r=180; g=160; b=150; }
    else { r=30 + Math.floor(t.height*120); g=80; b=30; }
    // if owned, tint
    if(t.region!=null){
      const owner = state.regions[t.region].owner;
      if(owner!=null){ const c=state.factions[owner].color; r = (r+c[0])/2|0; g=(g+c[1])/2|0; b=(b+c[2])/2|0; }
    }
    img.data[idx++]=r; img.data[idx++]=g; img.data[idx++]=b; img.data[idx++]=255;
  }
  mctx.putImageData(img,0,0);
  // scale and place small canvas into minimap element
  mm.style.width = '100%'; mm.style.height = '100%'; mm.style.imageRendering = 'pixelated';
}

// ---- UI Bindings --------------------------------------------------------
const els = {
  btnNew: document.getElementById('btn-new'),
  btnTurn: document.getElementById('btn-turn'),
  btnAuto: document.getElementById('btn-auto'),
  btnSave: document.getElementById('btn-save'),
  btnLoad: document.getElementById('btn-load'),
  btnExport: document.getElementById('btn-export'),
  fileImport: document.getElementById('file-import'),
  factionList: document.getElementById('faction-list'),
  selectedInfo: document.getElementById('selected-info'),
  turnEl: document.getElementById('turn'),
  eraEl: document.getElementById('era'),
  fcountEl: document.getElementById('fcount'),
  eraSlider: document.getElementById('era-slider'),
  editToggle: document.getElementById('edit-toggle'),
  tooltip: document.getElementById('tooltip')
};

els.btnNew.onclick = ()=>startNewGame();
els.btnTurn.onclick = ()=>{ advanceTurn(); };
els.btnAuto.onclick = ()=>{ state.autoPlay = !state.autoPlay; els.btnAuto.textContent = state.autoPlay ? 'Auto Play ✓' : 'Auto Play'; runAuto(); };
els.btnSave.onclick = ()=>saveToStorage();
els.btnLoad.onclick = ()=>loadFromStorage();
els.btnExport.onclick = ()=>exportJSON();
els.fileImport.onchange = (e)=>importJSONFile(e.target.files[0]);
els.editToggle.onclick = ()=>{ state.editMode = !state.editMode; els.editToggle.textContent = state.editMode ? 'Edit: ON' : 'Edit Mode'; };

els.eraSlider.oninput = (e)=>{ state.eraIndex = parseInt(e.target.value); updateUI(); render(); };

canvas.addEventListener('click', (ev)=>{
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor((ev.clientX - rect.left) / config.tileSize);
  const y = Math.floor((ev.clientY - rect.top) / config.tileSize);
  handleClickAt(x,y, ev.shiftKey);
});

function handleClickAt(x,y,shift){
  if(x<0||y<0||x>=config.mapW||y>=config.mapH) return;
  const tile = state.map[y][x];
  state.selected = tile;
  if(state.editMode){
    // toggle ownership to next faction
    const region = state.regions[tile.region];
    region.owner = ((region.owner==null)?0:((region.owner+1) % state.factions.length));
    updateUI();
    computeVision();
    render();
    return;
  }
  // show selected info
  let info = `Tile (${x},${y})<br/>Height: ${tile.height.toFixed(2)}<br/>`;
  if(tile.water) info += 'Water<br/>';
  if(tile.mountain) info += 'Mountain<br/>';
  if(tile.region!=null){
    const r = state.regions[tile.region];
    info += `Region ${r.id} — owner: ${r.owner==null? 'None': state.factions[r.owner].name }<br/>`;
  }
  if(tile.city) info += `City: ${tile.city.name} (owner ${tile.city.owner})<br/>`;
  if(tile.unit) info += `Unit: ${tile.unit.type.name} (owner ${tile.unit.owner})<br/>`;
  els.selectedInfo.innerHTML = info;
  render();
}

// Keyboard shortcuts
window.addEventListener('keydown', (e)=>{
  if(e.key==='n' || e.key==='N') startNewGame();
  if(e.key===' ') { advanceTurn(); e.preventDefault(); }
  if(e.key==='a' || e.key==='A') { els.btnAuto.click(); }
  if(e.key==='s' || e.key==='S') { saveToStorage(); }
  if(e.key==='l' || e.key==='L') { loadFromStorage(); }
});

// ---- Save / Load / Export ------------------------------------------------
function saveToStorage(){
  const snapshot = {
    seed: config.seed, turn: state.turn, eraIndex: state.eraIndex,
    map: state.map.map(row=>row.map(t=>({height:t.height,water:t.water,mountain:t.mountain,region:t.region,city:t.city?{owner:t.city.owner,name:t.city.name}:null,unit:t.unit?{id:t.unit.id,type:Object.keys(UNIT_TYPES).find(k=>UNIT_TYPES[k]===t.unit.type),owner:t.unit.owner,x:t.unit.x,y:t.unit.y}:null}))),
    regions: state.regions.map(r=>({id:r.id,owner:r.owner,tilesCount:r.tiles.length})),
    factions: state.factions.map(f=>({id:f.id,name:f.name,color:f.color,treasury:f.treasury,regions:f.regions,units:f.units.map(u=>({id:u.id,type:Object.keys(UNIT_TYPES).find(k=>UNIT_TYPES[k]===u.type),x:u.x,y:u.y,hp:u.hp}))}))
  };
  localStorage.setItem('age_conflict_save_v1', JSON.stringify(snapshot));
  alert('Saved to localStorage (age_conflict_save_v1).');
}

function loadFromStorage(){
  const raw = localStorage.getItem('age_conflict_save_v1');
  if(!raw){ alert('No save found.'); return; }
  try{
    const snapshot = JSON.parse(raw);
    // quick restore: regenerate map with same seed
    config.seed = snapshot.seed || config.seed;
    state = initializeEmptyState(config.seed);
    state.turn = snapshot.turn || 0;
    state.eraIndex = snapshot.eraIndex || 0;
    // for simplicity just new game with same seed
    render(); updateUI();
  }catch(e){ alert('Failed to load: '+e.message); }
}

function exportJSON(){
  const data = {
    seed: config.seed,
    turn: state.turn,
    eraIndex: state.eraIndex,
    factions: state.factions.map(f=>({id:f.id,name:f.name,color:f.color,treasury:f.treasury,regions:f.regions}))
  };
  const blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'age_conflict_export.json'; a.click();
  URL.revokeObjectURL(url);
}

function importJSONFile(file){
  if(!file) return;
  const reader = new FileReader();
  reader.onload = (e)=>{
    try{
      const data = JSON.parse(e.target.result);
      // simple import: change seed if present
      if(data.seed) config.seed = data.seed;
      startNewGame();
    }catch(err){ alert('Invalid JSON'); }
  };
  reader.readAsText(file);
}

// ---- Init / New Game ----------------------------------------------------
function initializeEmptyState(seed){
  state = {
    rng: rand(seed),
    map: generateMap(seed),
    regions: [],
    factions: [],
    turn:0, eraIndex:0, selected:null, autoPlay:false, editMode:false, animQueue:[]
  };
  state.regions = generateRegions(state.map, seed, Math.floor((config.mapW*config.mapH)/300));
  state.factions = createFactions(config.factionsCount, state.regions, seed);
  computeVision();
  return state;
}

function startNewGame(){
  config.seed = Math.floor(Math.random()*1e9);
  state = initializeEmptyState(config.seed);
  // place some random cities
  for(let i=0;i<config.initialSettlements;i++){
    const r = pick(state.regions, state.rng);
    const t = pick(r.tiles, state.rng);
    if(!t.water && !t.mountain && !t.city){
      // create neutral city
      t.city = {owner:null, name:'Town', garrison:[]};
    }
  }
  render(); updateUI();
}

// ---- UI Update -----------------------------------------------------------
function updateUI(){
  els.turnEl.textContent = state.turn;
  const eras = ['Ancient','Medieval','Gunpowder','Industrial'];
  els.eraEl.textContent = eras[clamp(state.eraIndex,0,eras.length-1)];
  els.fcountEl.textContent = state.factions.length;
  // faction list
  els.factionList.innerHTML = '';
  for(const f of state.factions){
    const li = document.createElement('li');
    const colorBox = document.createElement('div'); colorBox.className='faction-color';
    colorBox.style.background = `rgb(${f.color[0]},${f.color[1]},${f.color[2]})`;
    li.appendChild(colorBox);
    const nm = document.createElement('div'); nm.style.flex='1';
    nm.innerHTML = `<strong>${f.name}</strong><br/><small style="color:var(--muted)">Regions: ${f.regions.length} · Treasury: ${f.treasury}</small>`;
    li.appendChild(nm);
    li.onclick = ()=>{ // center view on capital
      state.selected = state.map[f.capital.y][f.capital.x];
      render(); updateUI();
    };
    els.factionList.appendChild(li);
  }
}

// ---- Auto Play loop -----------------------------------------------------
let autoInterval=null;
function runAuto(){
  if(state.autoPlay){
    if(autoInterval) clearInterval(autoInterval);
    autoInterval = setInterval(()=>{ advanceTurn(); if(state.turn>config.maxTurns) { clearInterval(autoInterval); state.autoPlay=false; } }, 650);
  } else {
    if(autoInterval) clearInterval(autoInterval);
  }
}

// ---- Boot ----------------------------------------------------------------
(function boot(){
  startNewGame();
  // attach canvas pan/zoom in future (simplified now)
  render();
  updateUI();
  // autosave every 30 turns to localStorage
  setInterval(()=>{ if(state.turn%30===0 && state.turn>0) saveToStorage(); }, 1000*30);
})();
