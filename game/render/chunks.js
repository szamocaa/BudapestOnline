// Global three.js shader-chunk patches, installed once before anything compiles (pipeline.js imports
// this module). They give every built-in material in the game, whoever made it, two things without
// touching their code:
//
// 1. Aerial perspective instead of flat fog. When scene.fog is a THREE.FogExp2 (the street scene,
//    sky.js sets it) the fog is height-dependent haze whose colour follows the sky: towards the sun
//    it glows warm, upwards it turns to the zenith colour. Its extra parameters live in FOG_UNIFORMS
//    (shared by reference with every material). Linear THREE.Fog (the metro) behaves as before.
//
// 2. Cascaded sun shadows. When a scene has two shadow-casting directional lights (sky.js: the sun's
//    near cascade first, its far cascade second, the far one with zero intensity), light 0 samples
//    the near map where it covers the fragment and blends into the far map elsewhere; light 1 adds
//    no light. Any other shadow setup renders exactly as stock three.js.
import * as THREE from '../vendor/three.module.min.js';

/** Shared fog parameters (plain objects so UniformsUtils.clone keeps them shared). */
export const FOG_UNIFORMS = {
	fogSun: { value: { x: 0, y: 1, z: 0, w: 0 } }, // world direction to the sun, w = glow strength
	fogSunColor: { value: { x: 0, y: 0, z: 0 } }, // radiance added looking into the sun
	fogZenith: { value: { x: 0, y: 0, z: 0 } }, // haze colour for rays going up
	fogParams: { value: { x: 0, y: 0, z: 1, w: 0 } }, // height falloff (1/m), base height, max opacity, enabled
};

const FOG_PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
	varying float vFogDepth;
	varying vec3 vFogView;
#endif
`;

const FOG_VERTEX = /* glsl */ `
#ifdef USE_FOG
	vFogDepth = - mvPosition.z;
	vFogView = mvPosition.xyz;
#endif
`;

const FOG_PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
	uniform vec3 fogColor;
	varying float vFogDepth;
	varying vec3 vFogView;
	#ifdef FOG_EXP2
		uniform float fogDensity;
		uniform vec4 fogSun;
		uniform vec3 fogSunColor;
		uniform vec3 fogZenith;
		uniform vec4 fogParams;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif
`;

const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
	vec3 fogCol = fogColor;
	#ifdef FOG_EXP2
		float fogFactor;
		if ( fogParams.w > 0.5 ) {
			float fogDist = length( vFogView );
			vec3 fogDir = vFogView / max( fogDist, 1e-4 );
			float fogRise = dot( fogDir, viewMatrix[ 1 ].xyz );
			float fogK = fogParams.x;
			float fogDh = fogDist * fogRise * fogK;
			float fogHf = abs( fogDh ) > 1e-3 ? ( 1.0 - exp( - fogDh ) ) / fogDh : 1.0 - 0.5 * fogDh;
			float fogOd = fogDensity * fogDist * exp( - fogK * max( cameraPosition.y - fogParams.y, 0.0 ) ) * fogHf;
			fogFactor = min( 1.0 - exp( - fogOd ), fogParams.z );
			float fogCs = max( dot( fogDir, ( viewMatrix * vec4( fogSun.xyz, 0.0 ) ).xyz ), 0.0 );
			float fogPhase = fogCs * fogCs;
			fogPhase = 0.35 * fogPhase + 0.65 * fogPhase * fogPhase * fogPhase * fogPhase;
			fogCol = mix( fogColor, fogZenith, smoothstep( 0.02, 0.7, fogRise ) ) + fogSunColor * ( fogPhase * fogSun.w );
		} else {
			fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
		}
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogCol, fogFactor );
#endif
`;

const CASCADE_PARS = /* glsl */ `
#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS >= 2
	float cascadeEdge( vec4 c ) {
		vec2 p = c.xy / c.w;
		vec2 e = min( p, 1.0 - p );
		return min( e.x, e.y );
	}
	float cascadedSunShadow() {
		DirectionalLightShadow s0 = directionalLightShadows[ 0 ];
		float w = smoothstep( 0.0, 0.1, cascadeEdge( vDirectionalShadowCoord[ 0 ] ) );
		float sh = 1.0;
		if ( w > 0.0 ) sh = getShadow( directionalShadowMap[ 0 ], s0.shadowMapSize, s0.shadowIntensity, s0.shadowBias, s0.shadowRadius, vDirectionalShadowCoord[ 0 ] );
		if ( w < 1.0 ) {
			DirectionalLightShadow s1 = directionalLightShadows[ 1 ];
			float far = getShadow( directionalShadowMap[ 1 ], s1.shadowMapSize, s1.shadowIntensity, s1.shadowBias, s1.shadowRadius, vDirectionalShadowCoord[ 1 ] );
			far = mix( 1.0, far, smoothstep( 0.0, 0.12, cascadeEdge( vDirectionalShadowCoord[ 1 ] ) ) );
			sh = mix( far, sh, w );
		}
		return sh;
	}
#endif
`;

const DIR_SHADOW_ORIGINAL = /* glsl */ `		#if defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
		directionalLightShadow = directionalLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
		#endif`;

const DIR_SHADOW_CASCADED = /* glsl */ `		#if defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS >= 2 && UNROLLED_LOOP_INDEX == 0
		directLight.color *= ( directLight.visible && receiveShadow && dot( directLight.color, vec3( 1.0 ) ) > 0.0 ) ? cascadedSunShadow() : 1.0;
		#elif defined( USE_SHADOWMAP ) && ( UNROLLED_LOOP_INDEX < NUM_DIR_LIGHT_SHADOWS )
		directionalLightShadow = directionalLightShadows[ i ];
		directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;
		#endif`;

const DIR_LOOP_HEAD = /* glsl */ `	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
		directionalLight = directionalLights[ i ];`;
const DIR_LOOP_HEAD_SKIP = /* glsl */ `	for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
		#if ! ( defined( USE_SHADOWMAP ) && NUM_DIR_LIGHT_SHADOWS >= 2 && UNROLLED_LOOP_INDEX == 1 )
		directionalLight = directionalLights[ i ];`;
const DIR_LOOP_TAIL = /* glsl */ `		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_RECT_AREA_LIGHTS > 0 )`;
const DIR_LOOP_TAIL_SKIP = /* glsl */ `		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
		#endif
	}
	#pragma unroll_loop_end
#endif
#if ( NUM_RECT_AREA_LIGHTS > 0 )`;

let installed = false;
export const patchStatus = { fog: false, cascades: false };

function replaceOnce(src, a, b) {
	const i = src.indexOf(a);
	if (i < 0 || src.indexOf(a, i + 1) >= 0) return null;
	return src.slice(0, i) + b + src.slice(i + a.length);
}

/** Installs the patches (idempotent). Must run before the first render. */
export function installChunks() {
	if (installed) return patchStatus;
	installed = true;
	const C = THREE.ShaderChunk;
	C.fog_pars_vertex = FOG_PARS_VERTEX;
	C.fog_vertex = FOG_VERTEX;
	C.fog_pars_fragment = FOG_PARS_FRAGMENT;
	C.fog_fragment = FOG_FRAGMENT;
	const add = (u) => { if (u && u.fogColor) for (const k in FOG_UNIFORMS) u[k] = { value: FOG_UNIFORMS[k].value }; };
	add(THREE.UniformsLib.fog);
	for (const k in THREE.ShaderLib) add(THREE.ShaderLib[k].uniforms);
	patchStatus.fog = true;

	// Cascades: only if the stock chunk looks exactly as expected (otherwise stay stock).
	let lf = C.lights_fragment_begin;
	const dirStart = lf.indexOf('#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )');
	if (dirStart >= 0) {
		let tail = lf.slice(dirStart);
		const steps = [[DIR_SHADOW_ORIGINAL, DIR_SHADOW_CASCADED], [DIR_LOOP_HEAD, DIR_LOOP_HEAD_SKIP], [DIR_LOOP_TAIL, DIR_LOOP_TAIL_SKIP]];
		for (const [a, b] of steps) tail = tail && replaceOnce(tail, a, b);
		if (tail) {
			C.lights_fragment_begin = lf.slice(0, dirStart) + tail;
			C.shadowmap_pars_fragment = C.shadowmap_pars_fragment + CASCADE_PARS;
			patchStatus.cascades = true;
		}
	}
	return patchStatus;
}

/** Sets the shared aerial-perspective parameters (all colours linear, scene units). */
export function setFogAtmosphere({ sunDir, sunGlow, sunColor, zenith, falloff, baseHeight, maxOpacity = 1, enabled = true }) {
	const u = FOG_UNIFORMS;
	u.fogSun.value.x = sunDir.x; u.fogSun.value.y = sunDir.y; u.fogSun.value.z = sunDir.z; u.fogSun.value.w = sunGlow;
	u.fogSunColor.value.x = sunColor.r; u.fogSunColor.value.y = sunColor.g; u.fogSunColor.value.z = sunColor.b;
	u.fogZenith.value.x = zenith.r; u.fogZenith.value.y = zenith.g; u.fogZenith.value.z = zenith.b;
	u.fogParams.value.x = falloff; u.fogParams.value.y = baseHeight; u.fogParams.value.z = maxOpacity; u.fogParams.value.w = enabled ? 1 : 0;
}
