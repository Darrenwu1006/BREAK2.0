// M9a CP4 鏡頭語言（第一版）：固定機位＋關鍵揭示微推近（判定/得分）。
// 廉價的張力演出：J4 thinkMs 加成已反映在事件 durationMs，鏡頭只跟 pushed 布林。

import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

/** CP5c：zoom out 後的桌面基準機位；Canvas 初始值與 CameraRig 共用，避免首幀跳動。 */
export const LAB_CAMERA_BASE: [number, number, number] = [0, 9.6, 9.9];
const BASE = new THREE.Vector3(...LAB_CAMERA_BASE);
const PUSHED = new THREE.Vector3(0, 8.2, 8.5);
const LOOK_AT = new THREE.Vector3(0, 0, 0.35);

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
