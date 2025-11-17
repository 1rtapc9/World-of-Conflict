/* Age of Conflict — Ultimate: script.js
Features included:
- Procedural world (fractal heightmap + rivers)
- Regions (Voronoi-like), capitals, cities
- Units (scout,infantry,cavalry,siege,naval) with A* pathfinding
- Fog of war, minimap, animations
- AI with diplomacy, alliances, trade, events, rebellions
- Tech tree, eras, dynamic economy, population model
- Particle system for combat VFX, audio hooks
- Scenario editor and save/load/export
*/


// -------------------- Config & State --------------------
const config = {
seed: Math.floor(Math.random()*1e9),
mapW: 160, mapH: 96, tileSize: 8,
factionsCount: 8,
initialCities: 10,
asymmetry: 0.2
};
let state = {
rng: null, map:null, regions:[], factions:[], turn:0, eraIndex:0, auto:false, edit:false, selected:null, anims:[]
};


// -------------------- RNG --------------------
function rngFactory(seed){ let s=seed>>>0; return ()=>{ s = (s * 1664525 + 1013904223) >>> 0; return s / 2**32; }; }


// -------------------- Noise / Heightmap --------------------
function valueNoise(w,h,seed){ const rnd = rngFactory(seed); const grid=[]; for(let x=0;x<=w;x++){grid[x]=[]; for(let y=0;y<=h;y++) grid[x][y]=rnd(); } return (u,v)=>{ const x=Math.floor(u*(w-1)), y=Math.floor(v*(h-1)); const fx=u*(w-1)-x, fy=v*(h-1)-y; const a=grid[x][y], b=grid[x+1][y], c=grid[x][y+1], d=grid[x+1][y+1]; const ix1=a+(b-a)*fx, ix2=c+(d-c)*fx; return ix1 + (ix2-ix1)*fy; }; }
function makeHeightmap(W,H,seed){ const base=valueNoise(32,32,seed); return (x,y)=>{ let nx=x/W, ny=y/H, amp=1,freq=1,sum=0,norm=0; for(let o=0;o<5;o++){ sum += amp*base((nx*freq)%1,(ny*freq)%1); norm += amp; amp*=0.5; freq*=2; } return sum/norm; } }


// -------------------- Map Gen --------------------
function generateMap(seed){ state.rng = rngFactory(seed); const W=config.mapW, H=config.mapH; const hm = makeHeightmap(W,H, seed ^ 0xdeadbeef); const map=[]; for(let y=0;y<H;y++){ map[y]=[]; for(let x=0;x<W;x++){ const h=hm(x,y); map[y][x]={x,y,height:h,water:h<0.48,mountain:h>0.80,region:null,city:null,unit:null,seen:[]}; } }
// rivers
for(let i=0;i<Math.floor(W*H*0.002);i++){ let rx=Math.floor(state.rng()*W), ry=Math.floor(state.rng()*H); for(let s=0;s<300;s++){ const t=map[ry][rx]; t.water = t.water || t.height < 0.52; let best={x:rx,y:ry,h:t.height}; for(let oy=-1;oy<=1;oy++) for(let ox=-1;ox<=1;ox++){ const nx=rx+ox, ny=ry+oy; if(nx>=0 && ny>=0 && nx<W && ny<H){ if(map[ny][nx].height < best.h){ best={x:nx,y:ny,h:map[ny][nx].height}; } } } if(best.x===rx && best.y===ry) break; rx=best.x; ry=best.y; map[ry][rx].water=true; } }
return map; }


function generateRegions(map,seed,regionCount=80){ const W=map[0].length,H=map.length; const rnd = rngFactory(seed^0xc0ffee); const seeds=[]; for(let i=0;i<regionCount;i++) seeds.push({x:Math.floor(rnd()*W),y:Math.floor(rnd()*H),id:i}); const regions = seeds.map(s=>({id:s.id,tiles:[],owner:null})); for(let y=0;y<H;y++) for(let x=0;x<W;x++){ let best=null,bestd=1e9; for(const s of seeds){ const dx=x-s.x, dy=y-s.y, d=dx*dx+dy*dy; if(d<bestd){bestd=d;best=s;} } map[y][x].region = best.id; regions[best.id].tiles.push(map[y][x]); }
// merge tiny regions
const minSize = Math.max(20, Math.floor((W*H)/240)); for(const r of regions.slice()) if(r.tiles.length<minSize){ const t=r.tiles[0]; let neighbor=null; for(let oy=-2;oy<=2;oy++) for(let ox=-2;ox<=2;ox++){ const nx=t.x+ox, ny=t.y+oy; if(nx>=0 && ny>=0 && nx<W && ny<H){ neighbor = map[ny][nx].region; if(neighbor!==r.id) break; } } if(neighbor!=null){ for(const tile of r.tiles){ tile.region = neighbor; regions[neighbor].tiles.push(tile); } r.tiles=[]; } }
// compact
const compact=[]; const mapOldToNew={}; let nid=0; for(const r of regions){ if(r.tiles.length>0){ mapOldToNew[r.id]=nid; r.id=nid; compact.push(r); nid++; } }
for(const r of compact) for(const t of r.tiles) t.region=r.id; return compact; }


// -------------------- Units, Factions, Tech --------------------
const UNIT_TYPES = {
scout:{name:'Scout',move:5,atk:1,def:1,sight:6,cost:10},
infantry:{name:'Infantry',move:3,atk:3,def:2,sight:4,cost:30},
cavalry:{name:'Cavalry',move:5,atk:4,def:2.5,sight:5,cost:50},
siege:{name:'Siege',move:1,atk:8,def:1,sight:3,cost:120},
ship:{name:'Ship',move:4,atk:2,def:1.5,sight:5,cost:60}
};


function createFactions(n,regions,seed){ const rnd=rngFactory(seed^0x1234); const colors=[]; for(let i=0;i<n;i++) colors.push([Math.floor(60+rnd()*180),Math.floor(60+rnd()*180),Math.floor(60+rnd()*180)]);
const factions=[]; const candidate = regions.filter(r=>r.tiles.some(t=>!t.water && !t.mountain));
for(let i=0;i<n;i++){ const r = candidate[Math.floor(rnd()*candidate.length)]; const tile = r.tiles[Math.floor(r.tiles.length*rnd())]; const f={id:i,name:`Faction ${i+1}`,color:colors[i],capital:{x:tile.x,y:tile.y},regions:[r.id],units:[],treasury:200+Math.floor(rnd()*300),tech:0,relations:{},aggression:0.6 + rnd()*1.2,population:1000+Math.floor(rnd()*2000)}; factions.push(f); }
// assign nearby regions
for(const f of factions){ for(const r of regions){ const center = r.tiles[Math.floor(r.tiles.length*0.4)]; const dx=center.x-f.capital.x, dy=center.y-f.capital.y; const d2 = dx*dx+dy*dy; if(d2 < (config.mapW*config.mapH/(factions.length*1.6))){ r.owner = f.id; if(!f.regions.includes(r.id)) f.regions.push(r.id); } }
// place capital city
const capTile = state.map[f.capital.y][f.capital.x]; capTile.city = {owner:f.id,name:f.name+' Capital',garrison:[]}; placeGarrison(capTile,f);
}
return factions;
}


function placeGarrison(tile,faction){ const rnd=state.rng; const num = 2 + Math.floor(rnd()*3); for(let i=0;i<num;i++){ const types=['infantry','scout','cavalry']; const t=UNIT_TYPES[types[Math.floor(rnd()*types.length)]]; const unit={id:'u'+Math.floor(
