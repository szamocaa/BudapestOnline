// Crowd materials: the figure from body.js is posed on the GPU. A 13-bone skeleton is evaluated per
// vertex from a handful of per-instance numbers (gait angle, animation state, body shape, style
// flags), so one draw call animates hundreds of people. The same pose code runs in the shadow
// depth material, so shadows follow the animation.
//
// Per-instance attributes (see npcView.js for how they are filled):
//   iA = (x, y, z, yaw)                     iB = (gait angle 0..2pi, anim, stride, seed)
//   iC = (height scale, female, heavy, age) iD = packed sRGB (skin, hair, top, legs)
//   iE = packed sRGB (skirt, shoes, accent, bag)
//   iF = (hair + 8*headwear, upper + 8*lower + 32*shoes, accessory bits, walkStyle + 4*idleStyle)
// anim: 0 walk, 1 idle, 2 run, 3 knocked down, 4 stunned.
import * as THREE from '../vendor/three.module.min.js';
import { jointSets, PARENT, HEAD_C } from './body.js';

export const ANIM = { WALK: 0, IDLE: 1, RUN: 2, KNOCKED: 3, STUNNED: 4 };

const vec3s = (list) => `vec3[13](${list.map((j) => `vec3(${j.map((v) => v.toFixed(4)).join(',')})`).join(',')})`;

function vertexPars() {
	const J = jointSets();
	return /* glsl */ `
attribute vec4 iA; attribute vec4 iB; attribute vec4 iC; attribute vec4 iD; attribute vec4 iE; attribute vec4 iF;
attribute vec4 aSkin; attribute vec4 aInfo; attribute vec3 aFem; attribute vec3 aFat;
uniform float uPeopleTime;
const vec3 pJM[13] = ${vec3s(J.male)};
const vec3 pJF[13] = ${vec3s(J.female)};
const vec3 pJH[13] = ${vec3s(J.heavy)};
const int pPAR[13] = int[13](${PARENT.join(',')});
const vec3 pHEAD = vec3(${HEAD_C.join(',')});
vec3 pE[13]; vec3 pJ[13]; vec3 pP0;
// Right arm by inverse kinematics (hand to ear / mouth): rotations of bones 11 and 12.
bool pIK = false; mat3 pM11; mat3 pM12;
#ifdef PEOPLE_COLOR
varying vec3 vPCol; varying vec3 vPRest; varying float vPRough;
flat varying float vPRegion; flat varying vec4 vPF; flat varying vec3 vPHair; flat varying float vPGroup;
#endif

float pWrap(float x) { return mod(x + PI, PI2) - PI; }
float pBump(float x, float c, float w) { float d = pWrap(x - c) / w; return exp(-d * d); }
float pPlateau(float x, float c, float w) { float d = pWrap(x - c) / w; d *= d; return exp(-d * d); }

mat3 pRot(vec3 e, bool limb) {
	float cx = cos(e.x), sx = sin(e.x), cy = cos(e.y), sy = sin(e.y), cz = cos(e.z), sz = sin(e.z);
	mat3 X = mat3(1., 0., 0., 0., cx, sx, 0., -sx, cx);
	mat3 Y = mat3(cy, 0., -sy, 0., 1., 0., sy, 0., cy);
	mat3 Z = mat3(cz, sz, 0., -sz, cz, 0., 0., 0., 1.);
	// Limbs twist about their own axis first, then flex, then spread; the trunk yaws last.
	return limb ? Z * X * Y : Y * X * Z;
}

// Leg b (thigh index) at gait angle ph: thigh flexion, knee and ankle curves of a real gait cycle
// (heel strike at ph = pi/2, toe-off near -0.9, peak knee flexion in early swing).
void pLeg(int b, float ph, float A, bool run) {
	float flex, knee;
	if (run) {
		flex = 0.22 + 0.62 * A * sin(ph);
		knee = 0.3 + 1.45 * pBump(ph, -0.3, 0.95) + 0.35 * pBump(ph, 2.3, 0.45);
	} else {
		flex = 0.06 + 0.4 * A * sin(ph);
		knee = 0.07 + (1.0 * pBump(ph, -0.15, 0.75) + 0.24 * pBump(ph, 2.45, 0.5)) * mix(0.55, 1.0, A);
	}
	float shin = flex - knee;
	float ankle = -shin * pPlateau(ph, 3.2, 1.25) + 0.14 * pBump(ph, 0.25, 0.6) - 0.1 * pBump(ph, -0.9, 0.35);
	pE[b] = vec3(-flex, 0., pE[b].z);
	pE[b + 1].x = knee;
	pE[b + 2].x = -ankle;
}

// Rotation taking unit vector a onto unit vector b (shortest arc).
mat3 pAlign(vec3 a, vec3 b) {
	vec3 v = cross(a, b); float c = dot(a, b);
	if (c < -0.999) return mat3(-1., 0., 0., 0., -1., 0., 0., 0., 1.);
	float k = 1.0 / (1.0 + c);
	return mat3(v.x * v.x * k + c, v.x * v.y * k + v.z, v.x * v.z * k - v.y,
		v.y * v.x * k - v.z, v.y * v.y * k + c, v.y * v.z * k + v.x,
		v.z * v.x * k + v.y, v.z * v.y * k - v.x, v.z * v.z * k + c);
}

// Two-bone IK for the right arm: hand centre to target T (chest space), elbow towards pole P.
void pReach(vec3 T, vec3 P) {
	vec3 S = pJ[11], El = pJ[12], Hc = El + vec3(-0.012, -0.335, 0.03);
	float a = length(El - S), b = length(Hc - El);
	vec3 d = T - S; float dl = clamp(length(d), 0.05, a + b - 0.002); vec3 dir = normalize(d);
	float along = (a * a - b * b + dl * dl) / (2.0 * dl), h = sqrt(max(a * a - along * along, 0.0));
	vec3 pp = normalize(P - dir * dot(P, dir));
	vec3 E = S + dir * along + pp * h;
	pM11 = pAlign(normalize(El - S), normalize(E - S));
	pM12 = pAlign(normalize(Hc - El), normalize(transpose(pM11) * normalize(S + dir * dl - E)));
	pIK = true;
}

void pSetup() {
	float fem = iC.y, fat = iC.z, age = iC.w;
	for (int i = 0; i < 13; i++) { pJ[i] = pJM[i] + (pJF[i] - pJM[i]) * fem + (pJH[i] - pJM[i]) * fat; pE[i] = vec3(0.); }
	pP0 = vec3(0.);
	float th = iB.x, A = iB.z, seed = iB.w;
	int anim = int(iB.y + 0.5);
	int act = int(iF.w + 0.5);
	int walkStyle = act % 4, idleStyle = act / 4;
	int acc = int(iF.z + 0.5);
	float t = uPeopleTime + seed * 61.0;
	float stoop = age * 0.26;
	float armOut = 0.09 + max(fat, 0.) * 0.1 + fem * 0.03;
	float headDown = 0.;
	pE[3].z = 0.015; pE[6].z = -0.015;
	if (anim == 0 || anim == 2) {
		bool run = anim == 2;
		float tl = th, tr = th + PI;
		float Aw = A * (1. - 0.3 * age);
		pLeg(3, tl, Aw, run); pLeg(6, tr, Aw, run);
		float sw = run ? 0.62 * A : 0.27 * Aw;
		float sL = -sw * sin(tl), sR = sw * sin(tl);
		float swL = 1., swR = 1.;
		if (!run && walkStyle == 1) { swL = 0.5; }
		if (!run && walkStyle == 3) { swL = 0.15; swR = 0.15; }
		if ((acc & 8) != 0) swR = 0.35;
		pE[9] = vec3(sL * swL * -1., 0., armOut);
		pE[11] = vec3(sR * swR * -1., 0., -armOut);
		pE[10].x = run ? -1.45 - 0.25 * sL : -(0.22 + 0.25 * max(sL, 0.) / max(sw, 0.01)) * swL - 0.05;
		pE[12].x = run ? -1.45 - 0.25 * sR : -(0.22 + 0.25 * max(sR, 0.) / max(sw, 0.01)) * swR - 0.05;
		float k = run ? 1.5 : 1.;
		pE[0] = vec3(run ? 0.1 : 0.02, -0.075 * k * Aw * sin(tl), -0.045 * Aw * cos(tl - 0.3));
		pP0 = vec3(-0.02 * Aw * cos(tl), (run ? -0.035 : 0.018) * Aw * cos(2. * tl) - 0.012 * Aw - (run ? 0.04 : 0.0), 0.);
		pE[1] = vec3((run ? 0.14 : 0.03) + stoop, 0.1 * k * Aw * sin(tl), 0.035 * Aw * cos(tl - 0.3));
		pE[2] = vec3(-0.6 * stoop - (run ? 0.12 : 0.0), -0.03 * Aw * sin(tl), 0.);
		if (!run) {
			if (walkStyle == 1) { pE[11] = vec3(-0.34, 0., 0.16); pE[12] = vec3(-1.4, -1.45, 0.); headDown = 0.42; }
			else if (walkStyle == 2) { pReach(vec3(-0.088, 1.585, 0.035), vec3(-0.5, -0.7, 0.5)); pE[2].z = 0.1; }
			else if (walkStyle == 3) { pE[9].x += 0.12; pE[11].x += 0.12; pE[9].z += 0.05; pE[11].z -= 0.05; pE[10].x = -0.55; pE[12].x = -0.55; }
			if ((acc & 8) != 0) { pE[11].z -= 0.1; pE[12].x = -0.08; }
			if ((acc & 16) != 0) { pE[11] = vec3(-0.28 - 0.12 * sin(tl), 0., -armOut); pE[12].x = -0.3; }
		}
	} else if (anim == 1) {
		float w = sin(t * 0.31);
		pP0 = vec3(0.022 * w, -0.004 - 0.006 * abs(w), 0.);
		pE[0] = vec3(0.02, 0.05 * sin(t * 0.21), 0.035 * w);
		float kl = 0.03 + 0.15 * max(0., -w), kr = 0.03 + 0.15 * max(0., w);
		pE[3] = vec3(-0.5 * kl, 0., 0.05 - 0.035 * w); pE[4].x = kl; pE[5].x = -0.5 * kl;
		pE[6] = vec3(-0.5 * kr, 0., -0.05 - 0.035 * w); pE[7].x = kr; pE[8].x = -0.5 * kr;
		pE[9] = vec3(-0.04, 0., armOut - 0.01); pE[10].x = -0.2;
		pE[11] = vec3(-0.04, 0., -armOut + 0.01); pE[12].x = -0.2;
		pE[1] = vec3(0.02 + stoop + 0.012 * sin(t * 1.5), -0.04 * sin(t * 0.21), 0.);
		pE[2] = vec3(0.04 - 0.6 * stoop + 0.04 * sin(t * 0.17), 0.45 * sin(t * 0.19) * smoothstep(0.1, 0.7, sin(t * 0.07 + seed)), 0.);
		if (idleStyle == 1) {
			pE[11] = vec3(-0.36, 0., 0.22); pE[12] = vec3(-1.45, -1.45, 0.);
			pE[9] = vec3(-0.3, 0., -0.14); pE[10] = vec3(-1.35, 1.2, 0.);
			headDown = 0.5; pE[2].y *= 0.2;
		} else if (idleStyle == 2) {
			pReach(vec3(-0.088, 1.585, 0.035), vec3(-0.5, -0.7, 0.5)); pE[2].z = 0.1;
			pE[9] = vec3(-0.12, 0., -0.02); pE[10] = vec3(-1.3, 1.1, 0.);
		} else if (idleStyle == 3) {
			pE[9] = vec3(0.12, 0., armOut + 0.05); pE[10].x = -0.55;
			pE[11] = vec3(0.12, 0., -armOut - 0.05); pE[12].x = -0.55;
		} else if (idleStyle == 4) {
			pE[9] = vec3(-0.42, -0.9, -0.08); pE[10].x = -1.85;
			pE[11] = vec3(-0.4, 0.9, 0.08); pE[12].x = -1.75;
		} else if (idleStyle == 5) {
			float f = fract(t / 9.0);
			float k = smoothstep(0.0, 0.1, f) * (1. - smoothstep(0.28, 0.4, f));
			pReach(mix(vec3(-0.15, 1.02, 0.12), vec3(-0.03, 1.56, 0.13), k), vec3(-0.6, -0.8, 0.0));
			pE[9] = vec3(0.12, 0., armOut + 0.05); pE[10].x = -0.55;
		}
	} else if (anim == 3) {
		// Knocked down: lying on the back, one knee up.
		pE[0] = vec3(-1.52, 0., 0.06); pP0 = vec3(0., -0.83, 0.);
		pE[3] = vec3(-0.6, 0., 0.12); pE[4].x = 1.1; pE[5].x = 0.3;
		pE[6] = vec3(-0.05, 0., -0.1); pE[7].x = 0.1; pE[8].x = 0.5;
		pE[9] = vec3(0.1, 0., 0.75); pE[10].x = -0.5;
		pE[11] = vec3(-0.35, 0., -0.45); pE[12].x = -0.3;
		pE[2] = vec3(-0.12, 0.45 + 0.08 * sin(uPeopleTime * 0.7 + seed), 0.);
	} else {
		// Stunned: crouched, hands over the face, trembling.
		float tr = 0.02 * sin(uPeopleTime * 13.0 + seed);
		pP0 = vec3(0., -0.07, 0.);
		pE[0] = vec3(0.22 + tr, 0., 0.);
		pE[3] = vec3(-0.45, 0., 0.08); pE[4].x = 0.75; pE[5].x = -0.3;
		pE[6] = vec3(-0.45, 0., -0.08); pE[7].x = 0.75; pE[8].x = -0.3;
		pE[1] = vec3(0.3, 0., 0.); pE[2] = vec3(0.25, 0., 0.);
		pE[9] = vec3(-1.1, 0., -0.25); pE[10].x = -2.15;
		pE[11] = vec3(-1.1, 0., 0.25); pE[12].x = -2.15;
	}
	pE[2].x += headDown;
}

vec3 pApply(int b, vec3 p, inout vec3 n) {
	for (int k = 0; k < 5; k++) {
		if (b < 0) break;
		mat3 R = pIK && b == 11 ? pM11 : pIK && b == 12 ? pM12 : pRot(pE[b], b >= 3);
		p = pJ[b] + R * (p - pJ[b]);
		n = R * n;
		if (b == 0) p += pP0;
		b = pPAR[b];
	}
	return p;
}

vec3 pUnpack(float f) {
	float r = floor(f / 65536.0), g = floor((f - r * 65536.0) / 256.0), b = f - r * 65536.0 - g * 256.0;
	return pow(vec3(r, g, b) / 255.0, vec3(2.2));
}

void pPose(out vec3 pos, out vec3 nrm) {
	pSetup();
	int region = int(aSkin.w + 0.5), group = int(aInfo.x + 0.5);
	int hair = int(iF.x + 0.5), hs = hair % 8, hw = hair / 8;
	int gar = int(iF.y + 0.5), upper = gar % 8, lower = (gar / 8) % 4;
	int acc = int(iF.z + 0.5), act = int(iF.w + 0.5), anim = int(iB.y + 0.5);
	bool show = true;
	if (group == 1) show = ((int(aInfo.y + 0.5) >> hs) & 1) == 1 && ((int(aInfo.z + 0.5) >> hw) & 1) == 1;
	else if (group == 2) show = upper == 2;
	else if (group == 3) show = lower == 2;
	else if (group == 4) show = (acc & int(aInfo.y + 0.5)) != 0;
	else if (group == 5) { int ws = act % 4, is = act / 4; show = (anim == 0 && (ws == 1 || ws == 2)) || (anim == 1 && (is == 1 || is == 2)); }
	else if (group == 6) show = upper == 3;
	else if (group == 7) show = !(hw == 0 && (hs == 0 || hs == 6));
	vec3 rest = position + aFem * iC.y + aFat * iC.z;
	if (upper == 1 && (region == 2 || group == 6)) rest += normal * 0.016; // puffer: thicker
	if (group == 1 && hs == 5 && region == 1) rest += normalize(rest - pHEAD) * 0.022; // curly: volume
	vec3 n0 = normal;
	vec3 p = pApply(int(aSkin.x + 0.5), rest, n0);
	if (aSkin.z > 0.001) {
		vec3 n1 = normal;
		vec3 p1 = pApply(int(aSkin.y + 0.5), rest, n1);
		p = mix(p, p1, aSkin.z);
		n0 = normalize(mix(n0, n1, aSkin.z));
	}
	p *= iC.x;
	float cy = cos(iA.w), sy = sin(iA.w);
	pos = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy) + iA.xyz;
	nrm = vec3(n0.x * cy + n0.z * sy, n0.y, -n0.x * sy + n0.z * cy);
	if (!show) pos = vec3(iA.x, -50.0, iA.z);
#ifdef PEOPLE_COLOR
	vec3 cSkin = pUnpack(iD.x), cHair = pUnpack(iD.y), cTop = pUnpack(iD.z), cLegs = pUnpack(iD.w);
	vec3 col = cSkin; float rough = 0.5;
	if (region == 1) { col = cHair; rough = 0.55; }
	else if (region == 2) { col = cTop; rough = upper == 1 ? 0.42 : upper == 4 ? 0.6 : upper == 0 ? 0.7 : 0.88; }
	else if (region == 3) { col = cLegs; rough = lower == 2 ? 0.6 : 0.85; }
	else if (region == 4) { col = pUnpack(iE.y); rough = 0.55; }
	else if (region == 5) { col = pUnpack(iE.z); rough = 0.9; }
	else if (region == 6) { col = pUnpack(iE.w); rough = 0.55; }
	else if (region == 7) { col = pUnpack(iE.x); rough = 0.8; }
	else if (region == 8) { col = vec3(0.012); rough = 0.25; }
	else if (region == 9) { col = vec3(0.05, 0.035, 0.025); rough = 0.5; }
	else if (region == 10) { col = hw > 0 ? pUnpack(iE.z) : cHair; rough = 0.7; }
	else if (region == 11) { col = pUnpack(iE.w) * 0.6; rough = 0.6; }
	vPCol = col; vPRough = rough; vPRest = position; vPRegion = float(region); vPF = iF; vPHair = cHair; vPGroup = float(group);
#endif
}
`;
}

const fragmentPars = /* glsl */ `
varying vec3 vPCol; varying vec3 vPRest; varying float vPRough;
flat varying float vPRegion; flat varying vec4 vPF; flat varying vec3 vPHair; flat varying float vPGroup;
const vec3 pHEAD = vec3(${HEAD_C.join(',')});
float pHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float pNoise(vec3 x) {
	vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
	return mix(mix(mix(pHash(i), pHash(i + vec3(1, 0, 0)), f.x), mix(pHash(i + vec3(0, 1, 0)), pHash(i + vec3(1, 1, 0)), f.x), f.y),
		mix(mix(pHash(i + vec3(0, 0, 1)), pHash(i + vec3(1, 0, 1)), f.x), mix(pHash(i + vec3(0, 1, 1)), pHash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
// Soft mask of a feature of size s at distance d (1 inside), widened and faded when it gets sub-pixel.
float pMask(float d, float s, float fw) { float a = fw / s; return (1.0 - smoothstep(1.0 - 0.35 - a, 1.0 + a, d)) / (1.0 + a * 0.6); }
float pLine(float d, float w, float fw) { return (1.0 - smoothstep(w, w + fw, abs(d))) * min(1.0, w / max(fw, 1e-5) + 0.15); }
float pHairline(float front) { return front > 0.0 ? 0.052 * pow(front, 0.8) : -0.085 * pow(-front, 1.2); }
float pSkinMask = 0.0;
vec3 pGlow = vec3(0.0);

vec3 pDetail(vec3 col, inout float rough) {
	int region = int(vPRegion + 0.5), group = int(vPGroup + 0.5);
	int hair = int(vPF.x + 0.5), hs = hair % 8, hw = hair / 8;
	int gar = int(vPF.y + 0.5), upper = gar % 8, lower = (gar / 8) % 4, shoe = gar / 32;
	int acc = int(vPF.z + 0.5);
	vec3 r = vPRest;
	float fw = max(fwidth(r.y), 1e-4);
	if (region == 0) {
		pSkinMask = 1.0;
		if (r.y > 1.535) {
			vec3 h = r - pHEAD;
			float front = normalize(h.xz + vec2(0.0, 1e-4)).y;
			float ax = abs(h.x);
			// Hair painted on the scalp (stubble for buzz cuts, the edge under every other style).
			if (hs != 6) {
				float hl = pHairline(front) + (hs == 0 ? 0.004 : -0.002);
				float m = smoothstep(hl - 0.003 - fw, hl + 0.003 + fw, h.y);
				col = mix(col, vPHair, m * (hs == 0 ? 0.72 : 0.95));
				rough = mix(rough, 0.7, m);
			}
			if (h.z > 0.04) {
				// Brows, eyes (white, iris, lash line), lips, beard.
				float bx = (ax - 0.032) / 0.021;
				float brow = pMask(abs(bx), 1.0, fw / 0.021) * pLine(h.y - (0.02 + 0.0045 * (1.0 - bx * bx)), 0.0023, fw);
				col = mix(col, vPHair * 0.85, brow * 0.85);
				float eyeD = length(vec2((ax - 0.031) / 0.0115, (h.y - 0.002) / 0.0056));
				float eye = pMask(eyeD, 1.0, fw / 0.0056);
				col = mix(col, vec3(0.62, 0.58, 0.55), eye * 0.8);
				float iris = pMask(length(vec2(ax - 0.031, h.y - 0.0015)), 0.0052, fw);
				col = mix(col, vec3(0.03, 0.02, 0.015), iris * eye * 1.2);
				float lidY = 0.002 + 0.0056 * sqrt(max(0.0, 1.0 - pow((ax - 0.031) / 0.0125, 2.0)));
				float lid = pLine(h.y - lidY, 0.0014, fw) * step(abs(ax - 0.031), 0.0135);
				col = mix(col, vec3(0.025, 0.018, 0.015), lid * 0.85);
				float sock = exp(-pow((ax - 0.031) / 0.02, 2.0) - pow((h.y - 0.004) / 0.014, 2.0));
				col *= 1.0 - 0.12 * sock; // shading around the eyes (reads at a distance)
				float lx = h.x / 0.0235;
				float lips = pMask(length(vec2(lx, (h.y + 0.0725) / 0.0075)), 1.0, fw / 0.0075);
				col = mix(col, col * vec3(0.8, 0.55, 0.55), lips * 0.7);
				float mouth = pLine(h.y + 0.0725 + 0.0015 * lx * lx, 0.0009, fw) * step(abs(lx), 0.95);
				col = mix(col, col * 0.4, mouth);
				col = mix(col, col * vec3(1.03, 0.9, 0.88), 0.35 * exp(-pow((ax - 0.045) / 0.018, 2.0) - pow((h.y + 0.03) / 0.018, 2.0))); // cheeks
				col *= 1.0 - 0.18 * exp(-pow(h.x / 0.012, 2.0) - pow((h.y + 0.052) / 0.004, 2.0)); // under the nose
				if ((acc & 192) != 0) {
					float jaw = smoothstep(-0.045, -0.06, h.y) * (1.0 - lips) + pLine(h.y + 0.062, 0.0045, fw) * step(ax, 0.026);
					col = mix(col, vPHair * 0.9, clamp(jaw, 0.0, 1.0) * ((acc & 128) != 0 ? 0.9 : 0.4));
				}
				if ((acc & 32) != 0) {
					float d = length(vec2(ax - 0.031, (h.y - 0.003) * 1.25));
					float frame = pLine(d - 0.0175, 0.0013, fw) + pLine(h.y - 0.007, 0.001, fw) * step(ax, 0.014);
					col = mix(col * (d < 0.0175 ? 0.85 : 1.0), vec3(0.02), clamp(frame, 0.0, 1.0));
				}
			} else if ((acc & 192) != 0 && h.y < -0.02 && front > -0.3) {
				col = mix(col, vPHair * 0.9, smoothstep(-0.02, -0.04, h.y) * ((acc & 128) != 0 ? 0.85 : 0.35));
			}
		}
	} else if (region == 1 || (region == 10 && hw == 0)) {
		// Hair: strands running down from the crown, a soft sheen.
		vec3 h = r - pHEAD;
		float st = pNoise(vec3(atan(h.x, h.z) * 30.0, h.y * 7.0, float(hs)));
		float st2 = pNoise(vec3(atan(h.x, h.z) * 75.0, h.y * 2.0, 3.0));
		col *= mix(1.0, 0.72 + 0.4 * st + 0.18 * st2, clamp(0.006 / fw, 0.0, 1.0));
		rough = 0.48;
	} else if (region == 2) {
		// Tops: zip, puffer quilting, hoodie pocket and strings, fabric grain.
		bool torso = abs(r.x) < 0.2 && r.y > 0.9 && r.y < 1.49;
		if (upper == 1) {
			float b = fract(r.y / 0.078);
			col *= mix(0.68, 1.0, smoothstep(0.0, 0.2, b) * smoothstep(1.0, 0.8, b));
		}
		if (torso && r.z > 0.04 && (upper == 0 || upper == 1 || upper == 4 || upper == 2)) col = mix(col, col * 0.35 + 0.02, pLine(r.x, 0.0018, fwidth(r.x)));
		if (torso && upper == 3 && r.z > 0.04) {
			float pocket = step(abs(r.x), 0.1) * step(0.96, r.y) * step(r.y, 1.1);
			col *= 1.0 - 0.12 * pocket;
			col = mix(col, vec3(0.75), pLine(abs(r.x) - 0.03, 0.002, fwidth(r.x)) * step(1.34, r.y) * step(r.y, 1.48));
		}
		col *= 0.94 + 0.12 * pNoise(r * vec3(90.0, 140.0, 90.0)) * clamp(0.004 / fw, 0.0, 1.0);
	} else if (region == 3) {
		if (lower == 2 && shoe == 1 && r.y < 0.34) { col = vec3(0.025, 0.02, 0.018); rough = 0.45; }
		else col *= 0.93 + 0.14 * pNoise(r * vec3(120.0, 60.0, 120.0)) * clamp(0.004 / fw, 0.0, 1.0);
	} else if (region == 4) {
		if (r.y < 0.022) { col = shoe == 0 ? vec3(0.8, 0.79, 0.76) : vec3(0.03); rough = 0.7; }
	} else if (region == 5 && group == 1 && hw == 2) {
		col *= 0.88 + 0.12 * sin(atan(r.x, r.z - pHEAD.z) * 60.0);
	} else if (region == 8) {
		float screen = step(-0.2015, r.x); // palm side of the phone (male rest pose, shX 0.196)
		pGlow = vec3(0.35, 0.45, 0.6) * screen * 0.35;
	}
	return col;
}
`;

/** The visible material (one per crowd: all LODs share it). */
export function createPeopleMaterial() {
	const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0 });
	mat.defines = { PEOPLE_COLOR: '' };
	mat.userData.uniforms = { uPeopleTime: { value: 0 } };
	mat.onBeforeCompile = (sh) => {
		sh.uniforms.uPeopleTime = mat.userData.uniforms.uPeopleTime;
		sh.vertexShader = sh.vertexShader
			.replace('#include <common>', `#include <common>\n${vertexPars()}`)
			.replace('#include <beginnormal_vertex>', 'vec3 pPos; vec3 objectNormal; pPose(pPos, objectNormal);')
			.replace('#include <begin_vertex>', 'vec3 transformed = pPos;');
		sh.fragmentShader = sh.fragmentShader
			.replace('#include <common>', `#include <common>\n${fragmentPars}`)
			.replace('#include <color_fragment>', '#include <color_fragment>\nfloat pRough = vPRough;\ndiffuseColor.rgb = pDetail(vPCol, pRough);')
			.replace('#include <roughnessmap_fragment>', 'float roughnessFactor = pRough;')
			.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += pGlow;')
			// Skin: a little warm light scattered under the surface instead of a grey terminator.
			.replace('#include <opaque_fragment>', 'outgoingLight += pSkinMask * (reflectedLight.indirectDiffuse * vec3(0.10, 0.03, 0.012) + reflectedLight.directDiffuse * vec3(0.05, 0.012, 0.0));\n#include <opaque_fragment>');
	};
	mat.customProgramCacheKey = () => 'people-v1';
	return mat;
}

/** Shadow-map material running the same pose. */
export function createPeopleDepthMaterial(uniforms) {
	const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
	mat.onBeforeCompile = (sh) => {
		sh.uniforms.uPeopleTime = uniforms.uPeopleTime;
		sh.vertexShader = sh.vertexShader
			.replace('#include <common>', `#include <common>\n${vertexPars()}`)
			.replace('#include <begin_vertex>', 'vec3 pPos; vec3 pNrm; pPose(pPos, pNrm); vec3 transformed = pPos;');
	};
	mat.customProgramCacheKey = () => 'people-depth-v1';
	return mat;
}
