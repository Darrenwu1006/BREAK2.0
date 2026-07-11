// 邊框式發光（[使用者 2026-07-10] 回饋 #6：發光做在物件邊框上、不要大面積溢出）。
// 四條細邊框＋脈動透明度；可拖曳卡底光與合法落區高亮共用。

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

export interface GlowFrameProps {
  /** 框內寬/高（XZ 平面） */
  width: number;
  height: number;
  /** 線寬 */
  thickness?: number;
  color?: string;
  /** 脈動透明度範圍 [min, max]；hidden 時阻尼歸零 */
  opacityRange?: [number, number];
  visible: boolean;
  position?: [number, number, number];
}

export function GlowFrame(props: GlowFrameProps): React.JSX.Element {
  const t = props.thickness ?? 0.05;
  const w = props.width + t;
  const h = props.height + t;
  const mat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: props.color ?? "#5ec2ff", transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
    [props.color],
  );
  const matRef = useRef(mat);
  matRef.current = mat;

  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.05);
    const [lo, hi] = props.opacityRange ?? [0.35, 0.7];
    const target = props.visible ? lo + (hi - lo) * (0.5 + 0.5 * Math.sin(performance.now() * 0.005)) : 0;
    matRef.current.opacity = THREE.MathUtils.damp(matRef.current.opacity, target, 12, dt);
  });

  return (
    <group position={props.position ?? [0, 0, 0]}>
      <mesh position={[0, 0, -h / 2]} material={mat}>
        <boxGeometry args={[w + t, 0.004, t]} />
      </mesh>
      <mesh position={[0, 0, h / 2]} material={mat}>
        <boxGeometry args={[w + t, 0.004, t]} />
      </mesh>
      <mesh position={[-w / 2, 0, 0]} material={mat}>
        <boxGeometry args={[t, 0.004, h]} />
      </mesh>
      <mesh position={[w / 2, 0, 0]} material={mat}>
        <boxGeometry args={[t, 0.004, h]} />
      </mesh>
    </group>
  );
}
