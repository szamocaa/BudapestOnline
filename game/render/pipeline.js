// The renderer and everything between the scene and the screen: tone mapping, shadows,
// post-processing, quality tiers.
//
// Contract with main.js:
//   const pipeline = createPipeline(canvas, { quality });
//   pipeline.renderer                 // THREE.WebGLRenderer
//   pipeline.render(scene, camera, frame)   // draw one frame (street or metro scene)
//   pipeline.resize(width, height)
//   pipeline.info()                   // { drawCalls, triangles, ... } for tests
import * as THREE from '../vendor/three.module.min.js';

export function createPipeline(canvas, { quality = 'high' } = {}) {
	const renderer = new THREE.WebGLRenderer({ canvas, antialias: quality !== 'low', powerPreference: 'high-performance' });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality === 'low' ? 1 : 1.75));
	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.shadowMap.enabled = quality !== 'low';
	renderer.shadowMap.type = THREE.PCFSoftShadowMap;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.outputColorSpace = THREE.SRGBColorSpace;

	let last = { drawCalls: 0, triangles: 0 };
	return {
		renderer,
		quality,
		render(scene, camera, frame) { // eslint-disable-line no-unused-vars
			renderer.render(scene, camera);
			last = { drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures };
		},
		resize(w, h) {
			renderer.setSize(w, h);
		},
		info: () => last,
	};
}
