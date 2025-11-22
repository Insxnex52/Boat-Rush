// --- game.js (fixed: draws boats + boss; keeps rest logic intact) ---
(() => {
  const canvas = document.getElementById('gameCanvas');
  const ctx = canvas.getContext('2d');
  function resize(){ canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
  window.addEventListener('resize', resize); resize();

  // DOM hooks (if present)
  const cover = document.getElementById('cover');
  const startBtn = document.getElementById('startBtn');
  const shipSelect = document.getElementById('shipSelect');
  const modeSelect = document.getElementById('modeSelect');
  const showLeaderboard = document.getElementById('showLeaderboard');
  const leaderboardBox = document.getElementById('leaderboard');
  const bgm = document.getElementById('bgm');
  const sfxPickup = document.getElementById('sfxPickup');
  const sfxHit = document.getElementById('sfxHit');
  const sfxShoot = document.getElementById('sfxShoot');
  const sfxBoss = document.getElementById('sfxBoss');

  // state
  let keys = {};
  window.addEventListener('keydown', e => keys[e.code] = true);
  window.addEventListener('keyup', e => keys[e.code] = false);

  let playing = false;
  let last = 0;
  let spawnTimer = 0, powerSpawn = 0, bossTimer = 0;
  let difficulty = 'endless';
  let leaderboard = JSON.parse(localStorage.getItem('boat_leader')||'[]');

  const MID = () => canvas.width/2;

  function rand(a,b){ return a + Math.random()*(b-a); }
  function clamp(v,a,b){ return Math.max(a,Math.min(b,v)); }

  function makePlayer(x, side, skin){
    const p = { x, side, w:70, h:34, vx:0, vy:0, angle:0, boost:0, shield:0, hp:100, lives:3, score:0, reversed:0, shotCooldown:0 };
    if(skin==='speed'){ p.maxSpeed=10; p.hp=80; p.color='#7ce7ff'; }
    else if(skin==='tank'){ p.maxSpeed=6; p.hp=160; p.color='#ff8c8c'; }
    else if(skin==='skimmer'){ p.maxSpeed=9; p.hp=90; p.color='#ffd166'; }
    else{ p.maxSpeed=8; p.hp=100; p.color='#00e7ff'; }
    p.hp = p.hp;
    // position y fixed near bottom
    p.y = canvas.height - 120;
    return p;
  }

  // instantiate players (will be re-applied on start)
  let p1 = makePlayer(120,'left','classic');
  let p2 = makePlayer(canvas.width-190,'right','speed');

  // entities
  let obstacles = [], powerups = [], bullets = [], homing = [], boss = null;

  // spawners
  function spawnObstacle(){
    const size = Math.floor(rand(26,56));
    const zig = Math.random() < 0.35;
    obstacles.push({ x: rand(60, canvas.width-60), y: -size, size, vy: rand(2.6,5.0), zig, phase: rand(0,Math.PI*2), amp: rand(8,36) });
  }
  function spawnPower(){ const types=['boost','shield','slow','reverse','triple','homing']; powerups.push({ x: rand(60, canvas.width-60), y:-30, size:34, type: types[Math.floor(rand(0,types.length))] }); }
  function spawnBoss(){ boss = { x: canvas.width/2 - 200, y:-160, w:400, h:120, hp: 400 + Math.floor(rand(0,240)), vy:0.6, phase:0, state:'entrance', cooldown:0 }; if(sfxBoss) try{ sfxBoss.play(); }catch(e){} }

  // apply ship selection before start
  function applyShipSelection(){
    const skin = (shipSelect && shipSelect.value) ? shipSelect.value : 'classic';
    p1 = makePlayer(120,'left',skin);
    p2 = makePlayer(canvas.width-190,'right',skin);
  }

  // shooting helper
  function shoot(player){
    if(!player) return;
    if(player.shotCooldown && player.shotCooldown>0) return;
    // bullets originate above the boat
    if(player.triple && player.triple>0){
      bullets.push({ x: player.x+6, y: player.y-12, vx:-1.2, vy:-10, owner: player });
      bullets.push({ x: player.x+player.w/2, y: player.y-12, vx:0, vy:-11, owner: player });
      bullets.push({ x: player.x+player.w-6, y: player.y-12, vx:1.2, vy:-10, owner: player });
    } else {
      bullets.push({ x: player.x + player.w/2, y: player.y - 12, vx: 0, vy: -11, owner: player });
    }
    player.shotCooldown = 12; // frames approx
    if(sfxShoot){ try{ sfxShoot.currentTime = 0; sfxShoot.play(); } catch(e){} }
  }

  // apply powerups
  function applyPower(player, other, type){
    if(!player) return;
    if(sfxPickup){ try{ sfxPickup.currentTime = 0; sfxPickup.play(); } catch(e){} }
    if(type==='boost') player.boost = 4200;
    if(type==='shield') player.shield = 5000;
    if(type==='slow') obstacles.forEach(o=> o.vy *= 0.6);
    if(type==='reverse') other.reversed = Math.max(other.reversed, 2600);
    if(type==='triple') player.triple = 5000;
    if(type==='homing') homing.push({ x: player.x + player.w/2, y: player.y - 20, target: other, vy: 5 });
  }

  // movement per player (split-screen enforced)
  function movePlayerControls(player, leftKey, rightKey, boostKey, shootKey, dt){
    const left = (player.reversed>0) ? keys[rightKey] : keys[leftKey];
    const right = (player.reversed>0) ? keys[leftKey] : keys[rightKey];

    let sp = player.maxSpeed || 8;
    if(player.boost>0) sp += 4;
    if(left) player.x -= sp * (dt/16);
    if(right) player.x += sp * (dt/16);

    // clamp to half-screen
    if(player.side === 'left') player.x = clamp(player.x, 10, canvas.width/2 - player.w - 10);
    else player.x = clamp(player.x, canvas.width/2 + 10, canvas.width - player.w - 10);

    // boost "used" gating handled by boost flag (kept simple)
    if(keys[shootKey]) shoot(player);

    if(player.shotCooldown) player.shotCooldown = Math.max(0, player.shotCooldown - (dt/16));
  }

  // collisions & interactions
  function rectRect(a,b){ return (a.x < b.x + (b.size||b.w) && a.x + (a.w||a.size) > b.x && a.y < b.y + (b.size||b.h) && a.y + (a.h||a.size) > b.y); }

  function checkCollisions(){
    // obstacles collisions
    obstacles.forEach(o=>{
      [p1,p2].forEach(pl=>{
        if(rectRect({x:pl.x,y:pl.y,w:pl.w,h:pl.h}, o)){
          if(pl.shield>0){ pl.shield = 0; }
          else { pl.hp -= Math.floor(rand(16,32)); if(sfxHit) try{ sfxHit.currentTime=0; sfxHit.play(); }catch(e){} }
          o.y = canvas.height + 999;
          if(pl.hp<=0){ pl.lives -=1; pl.hp = pl.lives>0 ? 100 : 0; if(pl.lives<=0) endGame(); }
        }
      });
    });

    // powerups collection
    powerups.forEach(pu=>{
      [ {p: p1, o: p2}, {p: p2, o: p1} ].forEach(pair=>{
        if(rectRect({x:pair.p.x,y:pair.p.y,w:pair.p.w,h:pair.p.h}, pu)){
          applyPower(pair.p, pair.o, pu.type);
          pu.y = canvas.height + 999;
        }
      });
    });

    // bullets vs boss/players
    bullets.forEach(b=>{
      // bullets hitting boss
      if(b.owner !== boss && boss && rectRect(b, boss)){
        boss.hp -= 12; b.y = -999;
        if(boss.hp <= 0){ boss = null; p1.score += 200; p2.score += 200; }
      }
      // bullets hitting players (friendly fire disabled)
      if(b.owner !== p1 && rectRect(b, p1)){ p1.hp -= 8; b.y = -999; if(sfxHit) try{ sfxHit.play(); }catch(e){} }
      if(b.owner !== p2 && rectRect(b, p2)){ p2.hp -= 8; b.y = -999; if(sfxHit) try{ sfxHit.play(); }catch(e){} }
    });

    // homing missiles hitting players
    homing.forEach(h=>{
      if(rectRect(h, p1)){ p1.hp -= 28; h.y = -999; }
      if(rectRect(h, p2)){ p2.hp -= 28; h.y = -999; }
    });
  }

  function endGame(){
    playing = false;
    try{ bgm && bgm.pause(); }catch(e){}
    const total = (p1.score + p2.score);
    leaderboard.push({ score: total, date: new Date().toISOString() });
    leaderboard.sort((a,b)=> b.score - a.score);
    localStorage.setItem('boat_leader', JSON.stringify(leaderboard.slice(0,20)));
    setTimeout(()=> alert('Game Over — combined score: ' + total), 50);
    cover.style.display = '';
  }

  // draw boat polygon (simple, visible)
  function drawBoatSimple(p){
    // hull color, slight rotation by vx
    ctx.save();
    ctx.translate(p.x + p.w/2, p.y + p.h/2);
    ctx.rotate((p.vx||0)/140);
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.moveTo(-p.w/2, p.h/2);
    ctx.lineTo(p.w/2, p.h/2);
    ctx.lineTo(p.w/2 - 6, -p.h/2);
    ctx.lineTo(-p.w/2 + 6, -p.h/2);
    ctx.closePath();
    ctx.fill();
    // cabin
    ctx.fillStyle = '#ffffff55';
    ctx.fillRect(-12, -p.h/2 + 2, 24, 12);
    ctx.restore();

    // wake
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    ctx.ellipse(p.x + p.w/2 - 8, p.y + p.h + 8, 26, 8, 0, 0, Math.PI*2);
    ctx.fill();
  }

  // draw boss (pirate ship style)
  function drawBoss(b){
    if(!b) return;
    ctx.save();
    ctx.fillStyle = '#8b2b2b';
    ctx.fillRect(b.x, b.y, b.w, b.h);
    // deck shapes
    ctx.fillStyle = '#5b1a1a';
    ctx.fillRect(b.x+20, b.y+8, b.w-40, 12);
    // cannons (dots)
    ctx.fillStyle = '#222';
    for(let i=0;i<6;i++){
      const cx = b.x + 40 + i*50;
      ctx.beginPath();
      ctx.arc(cx, b.y + b.h - 12, 8, 0, Math.PI*2);
      ctx.fill();
    }
    // boss HP
    ctx.fillStyle = '#fff';
    ctx.font = '20px Arial';
    ctx.fillText('BOSS HP: ' + Math.max(0, Math.floor(b.hp)), b.x + 16, b.y + 28);
    ctx.restore();
  }

  // draw all elements
  function drawAll(){
    // background water
    const g = ctx.createLinearGradient(0,0,0,canvas.height);
    g.addColorStop(0, '#6fc3ff'); g.addColorStop(1, '#0f7bb0');
    ctx.fillStyle = g; ctx.fillRect(0,0,canvas.width,canvas.height);

    // left clip: draw p1 and its lane objects
    ctx.save(); ctx.beginPath(); ctx.rect(0,0,canvas.width/2,canvas.height); ctx.clip();
    drawBoatSimple(p1);
    ctx.restore();

    // right clip: draw p2 and its lane objects
    ctx.save(); ctx.beginPath(); ctx.rect(canvas.width/2,0,canvas.width/2,canvas.height); ctx.clip();
    drawBoatSimple(p2);
    ctx.restore();

    // divider
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fillRect(canvas.width/2 - 2, 0, 4, canvas.height);

    // obstacles (global)
    ctx.fillStyle = '#6b6b6b';
    obstacles.forEach(o => ctx.fillRect(o.x, o.y, o.size, o.size));

    // powerups
    ctx.fillStyle = '#ffd166';
    powerups.forEach(pu => {
      ctx.fillRect(pu.x, pu.y, pu.size, pu.size);
      ctx.fillStyle = '#000';
      ctx.font = '12px Arial';
      ctx.fillText(pu.type[0].toUpperCase(), pu.x + pu.size/3, pu.y + pu.size/1.6);
      ctx.fillStyle = '#ffd166';
    });

    // bullets
    ctx.fillStyle = '#fff';
    bullets.forEach(b => ctx.fillRect(b.x, b.y, 6, 10));

    // homing
    ctx.fillStyle = '#ff7777';
    homing.forEach(h => ctx.fillRect(h.x-6, h.y-6, 12, 12));

    // boss
    drawBoss(boss);

    // HUD update (assumes elements exist)
    try {
      document.getElementById('p1hp').innerText = 'HP:' + Math.floor(p1.hp);
      document.getElementById('p2hp').innerText = 'HP:' + Math.floor(p2.hp);
      document.getElementById('p1lives').innerText = 'L:' + p1.lives;
      document.getElementById('p2lives').innerText = 'L:' + p2.lives;
      document.getElementById('p1boost').innerText = Math.floor(p1.boost/10);
      document.getElementById('p2boost').innerText = Math.floor(p2.boost/10);
    } catch(e){}
  }

  // update loop
  function updateEntities(dt){
    obstacles.forEach(o=>{
      o.phase += 0.03 + dt/2000;
      if(o.zig) o.x += Math.sin(o.phase) * o.amp * 0.02;
      o.y += o.vy * (dt/16);
    });
    obstacles = obstacles.filter(o => o.y < canvas.height + 200);

    powerups.forEach(p => p.y += 2 * (dt/16));
    powerups = powerups.filter(p => p.y < canvas.height + 150);

    bullets.forEach(b => { b.x += b.vx; b.y += b.vy * (dt/16); });
    bullets = bullets.filter(b => b.y > -100 && b.y < canvas.height + 100);

    homing.forEach(h => {
      const t = h.target;
      if(!t) return;
      const dx = (t.x + t.w/2) - h.x;
      const dy = (t.y + t.h/2) - h.y;
      const mag = Math.sqrt(dx*dx + dy*dy) || 1;
      h.x += (dx/mag) * h.vy;
      h.y += (dy/mag) * h.vy;
    });
    homing = homing.filter(h => h.y > -200 && h.y < canvas.height + 200);

    if(boss){
      boss.phase += 0.01 * (dt/16);
      boss.y = Math.min(60, boss.y + boss.vy * (dt/16));
      boss.cooldown = (boss.cooldown || 0) + dt;
      if(boss.cooldown > 1200){
        // boss shoots a projectile downwards
        bullets.push({ x: boss.x + rand(40,boss.w-40), y: boss.y + boss.h, vx: rand(-2,2), vy: 4, owner: boss });
        boss.cooldown = 0;
      }
    }
  }

  // main loop
  function loop(t){
    if(!playing) return;
    if(!last) last = t;
    const dt = t - last; last = t;

    spawnTimer += dt;
    powerSpawn += dt;
    bossTimer += dt;

    let spawnRate = difficulty === 'hard' ? 420 : (difficulty === 'boss' ? 520 : 700);
    if(spawnTimer > spawnRate){ spawnObstacle(); if(Math.random()<0.25) spawnObstacle(); spawnTimer = 0; }
    if(powerSpawn > 4200){ spawnPower(); powerSpawn = 0; }
    if(bossTimer > 25000 && difficulty !== 'endless' && !boss){ spawnBoss(); bossTimer = 0; }

    // apply controls and update entities
    movePlayerControls(p1,'KeyA','KeyD','KeyW','KeyS',dt);
    movePlayerControls(p2,'ArrowLeft','ArrowRight','ArrowUp','ArrowDown',dt);

    updateEntities(dt);
    checkCollisions();

    // reduce effect timers
    ['boost','shield','triple'].forEach(k => { if(p1[k]>0) p1[k] = Math.max(0, p1[k] - dt); if(p2[k]>0) p2[k] = Math.max(0, p2[k] - dt); });
    if(p1.reversed>0) p1.reversed = Math.max(0, p1.reversed - dt);
    if(p2.reversed>0) p2.reversed = Math.max(0, p2.reversed - dt);

    // draw
    drawAll();

    requestAnimationFrame(loop);
  }

  // start button binding
  if(startBtn) startBtn.addEventListener('click', ()=>{
    difficulty = (modeSelect && modeSelect.value) ? modeSelect.value : 'endless';
    applyShipSelection();
    // reset state
    obstacles = []; powerups = []; bullets = []; homing = []; boss = null;
    p1.score = p2.score = 0; p1.lives = p2.lives = 3; p1.hp = p1.hp; p2.hp = p2.hp;
    cover.style.display = 'none'; playing = true; last = 0;
    try{ bgm.volume = 0.22; bgm.play().catch(()=>{}); }catch(e){}
    requestAnimationFrame(loop);
  });

  if(showLeaderboard) showLeaderboard.addEventListener('click', ()=>{
    leaderboardBox.classList.toggle('hidden');
    if(!leaderboardBox.classList.contains('hidden')){
      leaderboardBox.innerHTML = '<h3>Leaderboard</h3>' + (leaderboard.length ? leaderboard.map((r,i)=>`<div>${i+1}. ${r.score} — ${new Date(r.date).toLocaleString()}</div>`).join('') : '<div>No scores yet</div>');
    }
  });

  // touch support: simple
  canvas.addEventListener('touchstart', e=>{
    const r = canvas.getBoundingClientRect();
    for(let t of e.touches){
      const x = t.clientX - r.left;
      if(x < r.width/2) keys['KeyA'] = true; else keys['ArrowLeft'] = true;
    }
  });
  canvas.addEventListener('touchend', e=>{ keys['KeyA']=keys['KeyD']=keys['ArrowLeft']=keys['ArrowRight']=false; });

  // expose for debug
  window.BoatRush = { start: ()=> startBtn && startBtn.click(), players: ()=> [p1,p2], bossRef: ()=> boss, entities: ()=> ({obstacles,powerups,bullets,homing}) };
})();
