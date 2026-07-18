// [使用者 2026-07-18] #2：卡片資訊移出 rail，成為場邊獨立浮動面板——
// 讀卡與讀 log 常同時進行，rail 保留給紀錄；本面板 DOM 定位在右上工具列（不登場鈕）同欄。
// [使用者 2026-07-18] 輪二：hover 面板不可能捲動——內容全部攤開、只留基礎資訊／技能／注釋。

import { buildCardSkillPresentation } from "../../shared/cardSkillPresentation";
import styles from "../UiLabApp.module.css";
import type { CardInspectView } from "./railViewModel";

export function CardInfoPanel(props: { card: CardInspectView; cardImage: string | null }): React.JSX.Element {
  const cardPresentation = buildCardSkillPresentation(props.card.card);
  return (
    <div>
      <div className={styles.railCardTop}>
        {props.cardImage ? <img className={styles.railCardImage} src={props.cardImage} alt="" aria-hidden="true" /> : <div className={styles.railCardImageEmpty} aria-hidden="true" />}
        <div className={styles.cardTitleBox}>
          <strong>{props.card.title}</strong>
          <span>{props.card.subtitle}</span>
          <div className={styles.cardThirdLine}>
            <span>{props.card.card.id}</span>
          </div>
        </div>
        <div className={styles.cardMiniMeta}>
          <div><span>類型</span><span>{props.card.card.type === "CHARACTER" ? "角色" : "事件"}</span></div>
          {props.card.card.positions.length > 0 && <div><span>位置</span><span>{props.card.card.positions.join(", ")}</span></div>}
          {props.card.card.grades.length > 0 && <div><span>學年</span><span>{props.card.card.grades.join(", ")}</span></div>}
        </div>
      </div>

      <div className={styles.railParams}>
        {props.card.params.map((param) => (
          <div key={param.label}>
            <span>{param.label}</span>
            <strong>{param.effective ?? "—"}</strong>
            {param.base !== param.effective && <small>原 {param.base ?? "—"}</small>}
          </div>
        ))}
      </div>

      {cardPresentation && (cardPresentation.timingBadges.length > 0 || cardPresentation.oncePerTurn) && (
        <div className={styles.railSkillTiming}>
          <span>{cardPresentation.timingLabel}</span>
          <div>
            {cardPresentation.timingBadges.map((badge) => (
              <b className={badge.kind === "area" ? styles.railAreaBadge : styles.railTimingBadge} key={badge.label}>{badge.label}</b>
            ))}
            {cardPresentation.oncePerTurn && <b className={styles.railRestrictionBadge}>一回合一次</b>}
          </div>
        </div>
      )}
      {cardPresentation && cardPresentation.body.length > 0 && (
        <div className={styles.railSkill}>
          <p>{cardPresentation.body.map((segment, index) => (
            <span className={segment.kind === "keyword" ? styles.railKeyword : undefined} key={index}>{segment.text}</span>
          ))}</p>
          {props.card.card.skillZhStatus === "machine" && <span className={styles.railMachineBadge}>翻譯待確認</span>}
        </div>
      )}
      {cardPresentation && (cardPresentation.annotationZh.length > 0 || cardPresentation.glossary.length > 0) && (
        <div className={styles.cardInfoNotes}>
          <span>效果說明</span>
          <ul>
            {(cardPresentation.annotationZh.length > 0
              ? cardPresentation.annotationZh
              : cardPresentation.glossary.map((item) => `${item.name}：${item.definition}`)
            ).map((line) => <li key={line}>{line}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
