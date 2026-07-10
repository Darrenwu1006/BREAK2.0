// M9a CP4 鏡頭語言（第一版）：固定機位＋關鍵揭示微推近（判定/得分）。
// 廉價的張力演出：J4 thinkMs 加成已反映在事件 durationMs，鏡頭只跟 pushed 布林。

import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

const BASE = new THREE.Vector3(0, 8.8, 8.6);
const PUSHED = new THREE.Vector3(0, 7.3, 6.8);
const LOOK_AT = new THREE.Vector3(0, 0, 0.6);

export function CameraRig(props: { pushed: boolean; enabled: boolean }): null {
  useFrame((s, dtRaw) => {
    if (!props.enabled) return;
    const dt = Math.min(dtRaw, 0.05);
    const target = props.pushed ? PUSHED : BASE;
    const cam = s.camera;
    cam.position.x = THREE.MathUtils.damp(cam.position.x, target.x, 3, dt);
    cam.position.y = THREE.MathUtils.damp(cam.position.y, target.y, 3, dt);
    cam.position.z = THREE.MathUtils.damp(cam.position.z, target.z, 3, dt);
    cam.lookAt(LOOK_AT);
  });
  return null;
}
