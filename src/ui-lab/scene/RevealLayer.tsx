// M9a CP5c 判定揭示層：OP/DP 固定在中線左右，不再跟來源卡區域移動；判定結果置中。
// 節奏由 usePlayback 的 reveal 狀態驅動（op→dp→judge 三拍，turn 邊界清空）——本檔只管長相。

import { Html } from "@react-three/drei";
import type { RevealView } from "../game/usePlayback";
import styles from "../UiLabApp.module.css";

export const OP_REVEAL_POSITION: [number, number, number] = [-1.05, 0.9, 0];
export const DP_REVEAL_POSITION: [number, number, number] = [1.05, 0.9, 0];

export function RevealLayer(props: { reveal: RevealView }): React.JSX.Element {
  const { op, dp, judge } = props.reveal;
  return (
    <group>
      {op && (
        <Html position={OP_REVEAL_POSITION} center style={{ pointerEvents: "none" }}>
          <div className={`${styles.chip} ${styles.chipOp}`}>OP {op.value}</div>
        </Html>
      )}
      {dp && (
        <Html position={DP_REVEAL_POSITION} center style={{ pointerEvents: "none" }}>
          <div className={`${styles.chip} ${styles.chipDp}`}>DP {dp.value}</div>
        </Html>
      )}
      {judge && (
        <Html position={[0, 2.3, 0]} center style={{ pointerEvents: "none" }}>
          <div className={judge.success ? styles.judgeHold : styles.judgeBreak}>
            {judge.success ? (judge.defense === "block" ? "攔網成功！" : "接球成功！") : "突破！！"}
          </div>
        </Html>
      )}
    </group>
  );
}
