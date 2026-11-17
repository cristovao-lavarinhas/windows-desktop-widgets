import {
  WebGLRenderer, Scene, PerspectiveCamera, Group, Mesh, Shape, ExtrudeGeometry, CapsuleGeometry,
  TorusGeometry, CircleGeometry, CylinderGeometry, SphereGeometry, PlaneGeometry,
  MeshStandardMaterial, MeshBasicMaterial, HemisphereLight, DirectionalLight, Color,
  CanvasTexture, ACESFilmicToneMapping, SRGBColorSpace, MathUtils,
} from 'three';

/**
 * Bot 3D procedural (sem modelos externos) para o widget.
 * API: setMood('idle'|'working'|'hot'|'over'), setPointer({ x, y, active }), poke(), dispose().
 */

const PALETTE = {
  shell: 0xece7e2,
  shellDark: 0xcfc8c1,
  face: 0x17181f,
  eye: 0x7ee0ff,
  accent: 0xd97757,
  warn: 0xf2b84b,
  danger: 0xef5d5d,
  sweat: 0x8fd3ff,
};

const ACTIVE_FRAME_INTERVAL = 1 / 30;
const IDLE_FRAME_INTERVAL = 1 / 15; // a dormir e sem rato por perto: metade do custo
const damp = (current, target, lambda, dt) => MathUtils.damp(current, target, lambda, dt);

function roundedRectShape(width, height, radius) {
  const x = -width / 2;
  const y = -height / 2;
  const shape = new Shape();
  shape.moveTo(x + radius, y);
  shape.lineTo(x + width - radius, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + radius);
  shape.lineTo(x + width, y + height - radius);
  shape.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  shape.lineTo(x + radius, y + height);
  shape.quadraticCurveTo(x, y + height, x, y + height - radius);
  shape.lineTo(x, y + radius);
  shape.quadraticCurveTo(x, y, x + radius, y);
  return shape;
}

function roundedBox(width, height, depth, radius, bevel) {
  const geometry = new ExtrudeGeometry(roundedRectShape(width - 2 * bevel, height - 2 * bevel, radius), {
    depth: depth - 2 * bevel,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 8,
    curveSegments: 16,
  });
  geometry.center();
  geometry.computeVertexNormals();
  return geometry;
}

function softShadowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(0,0,0,0.55)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  return new CanvasTexture(canvas);
}

export class Bot3D {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.outputColorSpace = SRGBColorSpace;

    this.scene = new Scene();
    this.camera = new PerspectiveCamera(30, 1, 0.1, 50);
    this.camera.position.set(0, 0.42, 5.1);
    this.camera.lookAt(0, 0.08, 0);

    this.mood = 'idle';
    this.pointer = { x: 0, y: 0, active: false };
    this.look = { yaw: 0, pitch: 0, eyeX: 0, eyeY: 0 };
    this.eyeOpen = 0.25;
    this.nextBlinkAt = 2;
    this.blinkUntil = 0;
    this.pokeStart = -10;
    this.elapsed = 0;
    this.sinceFrame = 0;
    this.lastTime = performance.now();
    this.running = true;

    this.buildLights();
    this.buildRobot();
    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  buildLights() {
    this.scene.add(new HemisphereLight(0xffffff, 0x3a3d50, 1.3));
    const key = new DirectionalLight(0xffffff, 2.0);
    key.position.set(2.5, 3, 4);
    this.scene.add(key);
    const rim = new DirectionalLight(0x9fc6ff, 1.1);
    rim.position.set(-3, 1.5, -2.5);
    this.scene.add(rim);
  }

  buildRobot() {
    const shellMaterial = new MeshStandardMaterial({ color: PALETTE.shell, roughness: 0.38, metalness: 0.05 });
    const shellDarkMaterial = new MeshStandardMaterial({ color: PALETTE.shellDark, roughness: 0.45, metalness: 0.1 });
    this.glowMaterial = new MeshBasicMaterial({ color: PALETTE.eye, toneMapped: false });
    this.antennaMaterial = new MeshStandardMaterial({
      color: PALETTE.accent, emissive: PALETTE.accent, emissiveIntensity: 0.6, roughness: 0.3,
    });
    this.cheekMaterial = new MeshBasicMaterial({ color: PALETTE.accent, transparent: true, opacity: 0, toneMapped: false });

    this.robot = new Group();
    this.head = new Group();
    this.robot.add(this.head);
    this.scene.add(this.robot);

    this.head.add(new Mesh(roundedBox(1.7, 1.36, 1.1, 0.34, 0.2), shellMaterial));

    const face = new Mesh(
      roundedBox(1.26, 0.88, 0.1, 0.26, 0.035),
      new MeshStandardMaterial({ color: PALETTE.face, roughness: 0.15, metalness: 0.2 }),
    );
    face.position.z = 0.53;
    this.head.add(face);

    this.eyes = new Group();
    this.eyes.position.set(0, 0.06, 0.6);
    this.eyeMeshes = [-0.24, 0.24].map((x) => {
      const eye = new Mesh(new CapsuleGeometry(0.075, 0.13, 6, 16), this.glowMaterial);
      eye.position.x = x;
      this.eyes.add(eye);
      return eye;
    });
    this.head.add(this.eyes);

    this.mouth = new Mesh(new TorusGeometry(0.12, 0.024, 8, 32, Math.PI), this.glowMaterial);
    this.mouth.rotation.z = Math.PI;
    this.mouth.position.set(0, -0.14, 0.59);
    this.head.add(this.mouth);

    for (const x of [-0.43, 0.43]) {
      const cheek = new Mesh(new CircleGeometry(0.06, 24), this.cheekMaterial);
      cheek.position.set(x, -0.16, 0.586);
      this.head.add(cheek);
    }

    for (const side of [-1, 1]) {
      const ear = new Mesh(new CylinderGeometry(0.15, 0.15, 0.16, 32), shellDarkMaterial);
      ear.rotation.z = Math.PI / 2;
      ear.position.x = side * 0.9;
      this.head.add(ear);
      const earCap = new Mesh(new CylinderGeometry(0.07, 0.07, 0.04, 24), this.antennaMaterial);
      earCap.rotation.z = Math.PI / 2;
      earCap.position.x = side * 0.99;
      this.head.add(earCap);
    }

    const stem = new Mesh(new CylinderGeometry(0.025, 0.03, 0.34, 12), shellDarkMaterial);
    stem.position.y = 0.84;
    this.head.add(stem);
    this.antennaBall = new Mesh(new SphereGeometry(0.09, 24, 16), this.antennaMaterial);
    this.antennaBall.position.y = 1.04;
    this.head.add(this.antennaBall);

    this.sweat = new Mesh(
      new SphereGeometry(0.05, 16, 12),
      new MeshBasicMaterial({ color: PALETTE.sweat, transparent: true, opacity: 0, toneMapped: false }),
    );
    this.sweat.scale.y = 1.4;
    this.head.add(this.sweat);

    this.shadow = new Mesh(
      new PlaneGeometry(1.8, 0.9),
      new MeshBasicMaterial({ map: softShadowTexture(), transparent: true, depthWrite: false }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.position.y = -1.05;
    this.scene.add(this.shadow);
  }

  resize() {
    const { clientWidth, clientHeight } = this.canvas;
    if (!clientWidth || !clientHeight) return;
    this.renderer.setSize(clientWidth, clientHeight, false);
    this.camera.aspect = clientWidth / clientHeight;
    this.camera.updateProjectionMatrix();
  }

  setMood(mood) {
    this.mood = mood;
  }

  /** x, y normalizados em [-1, 1] relativamente ao centro do bot; active = cursor sobre o widget. */
  setPointer(pointer) {
    this.pointer = pointer;
  }

  poke() {
    this.pokeStart = this.elapsed;
  }

  dispose() {
    this.running = false;
    this.resizeObserver.disconnect();
    this.renderer.dispose();
  }

  loop(now) {
    if (!this.running) return;
    requestAnimationFrame(this.loop);
    const delta = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;
    this.sinceFrame += delta;
    const resting = this.mood === 'idle' && !this.pointer.active && this.elapsed - this.pokeStart > 1;
    if (this.sinceFrame < (resting ? IDLE_FRAME_INTERVAL : ACTIVE_FRAME_INTERVAL)) return;
    const dt = this.sinceFrame;
    this.sinceFrame = 0;
    this.elapsed += dt;
    this.update(dt, this.elapsed);
    this.renderer.render(this.scene, this.camera);
  }

  update(dt, t) {
    const { mood, pointer } = this;
    const following = pointer.active;

    // --- Para onde olha ---
    let targetYaw;
    let targetPitch;
    let targetEyeX;
    let targetEyeY;
    if (following) {
      targetYaw = pointer.x * 0.6;
      targetPitch = pointer.y * 0.38;
      targetEyeX = pointer.x * 0.07;
      targetEyeY = -pointer.y * 0.05;
    } else if (mood === 'working') {
      targetYaw = Math.sin(t * 0.9) * 0.18;
      targetPitch = 0.06;
      targetEyeX = Math.sin(t * 2.6) * 0.06;
      targetEyeY = -0.02;
    } else if (mood === 'idle') {
      targetYaw = Math.sin(t * 0.35) * 0.12;
      targetPitch = 0.16; // cabeça "a cabecear" de sono
      targetEyeX = 0;
      targetEyeY = -0.02;
    } else {
      targetYaw = Math.sin(t * 0.7) * 0.1;
      targetPitch = 0;
      targetEyeX = 0;
      targetEyeY = 0;
    }
    const speed = following ? 9 : 3;
    this.look.yaw = damp(this.look.yaw, targetYaw, speed, dt);
    this.look.pitch = damp(this.look.pitch, targetPitch, speed, dt);
    this.look.eyeX = damp(this.look.eyeX, targetEyeX, speed * 1.4, dt);
    this.look.eyeY = damp(this.look.eyeY, targetEyeY, speed * 1.4, dt);

    // --- Poke: salto + pirueta ---
    const pokeAge = t - this.pokeStart;
    const poking = pokeAge < 0.8;
    const pokeProgress = MathUtils.clamp(pokeAge / 0.8, 0, 1);
    const spin = poking ? MathUtils.smootherstep(pokeProgress, 0, 1) * Math.PI * 2 : 0;
    const jump = poking ? Math.sin(pokeProgress * Math.PI) * 0.35 : 0;

    // --- Corpo ---
    const floatY = Math.sin(t * (mood === 'idle' ? 1.2 : 2)) * 0.06;
    this.robot.position.y = floatY + jump;
    this.head.rotation.y = this.look.yaw + spin;
    this.head.rotation.x = this.look.pitch;
    this.head.rotation.z = mood === 'over' ? Math.sin(t * 28) * 0.05 : this.look.yaw * -0.12;
    this.eyes.position.x = this.look.eyeX;
    this.eyes.position.y = 0.06 + this.look.eyeY;

    const shadowScale = 1 - (floatY + jump) * 0.9;
    this.shadow.scale.set(shadowScale, shadowScale, 1);
    this.shadow.material.opacity = 0.9 - jump;

    // --- Olhos: abertura + pestanejar ---
    const sleepy = mood === 'idle' && !following && !poking;
    let eyeTarget = sleepy ? 0.22 + Math.sin(t * 1.3) * 0.05 : 1;
    if (poking) eyeTarget = 0.35; // olhos "felizes"
    if (t > this.nextBlinkAt && !sleepy) {
      this.blinkUntil = t + 0.12;
      this.nextBlinkAt = t + 2.5 + Math.random() * 3;
    }
    if (t < this.blinkUntil) eyeTarget = 0.08;
    this.eyeOpen = damp(this.eyeOpen, eyeTarget, t < this.blinkUntil ? 40 : 10, dt);
    for (const eye of this.eyeMeshes) eye.scale.y = this.eyeOpen;

    this.mouth.scale.y = mood === 'working' && !following ? 0.6 + Math.abs(Math.sin(t * 9)) * 0.6 : 1;

    // --- Cores por humor ---
    const glowTarget = mood === 'over' ? PALETTE.danger : PALETTE.eye;
    this.glowMaterial.color.lerp(new Color(glowTarget), Math.min(1, dt * 6));

    const antennaTarget = mood === 'over' ? PALETTE.danger : mood === 'hot' ? PALETTE.warn : PALETTE.accent;
    this.antennaMaterial.color.lerp(new Color(antennaTarget), Math.min(1, dt * 6));
    this.antennaMaterial.emissive.copy(this.antennaMaterial.color);
    const pulse = mood === 'working' || mood === 'over' ? 0.5 + Math.abs(Math.sin(t * (mood === 'over' ? 8 : 4))) : 0.6;
    this.antennaMaterial.emissiveIntensity = following ? 1.6 : pulse;

    const cheekTarget = mood === 'hot' || mood === 'over' || following ? 0.85 : 0;
    this.cheekMaterial.opacity = damp(this.cheekMaterial.opacity, cheekTarget, 6, dt);

    // --- Gota de suor (só "hot") ---
    if (mood === 'hot') {
      const cycle = (t % 1.8) / 1.8;
      this.sweat.position.set(0.72, 0.48 - cycle * 0.45, 0.45);
      this.sweat.material.opacity = cycle < 0.3 ? cycle / 0.3 : 1 - (cycle - 0.3) / 0.7;
    } else {
      this.sweat.material.opacity = 0;
    }
  }
}
