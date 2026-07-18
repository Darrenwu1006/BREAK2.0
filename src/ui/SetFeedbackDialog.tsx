import { useState } from "react";
import type { ReplaySetFeedbackTag, ReplaySetResult } from "../shared/replayHistory";
import { REPLAY_SET_FEEDBACK_OPTIONS } from "../shared/replaySetFeedbackOptions";

const HUMAN = 0;

export function SetFeedbackDialog(props: {
  result: ReplaySetResult;
  onSubmit: (tag: ReplaySetFeedbackTag, note?: string) => void;
  onSkip: () => void;
}): React.JSX.Element {
  const [selected, setSelected] = useState<ReplaySetFeedbackTag | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const playerWon = props.result.winner === HUMAN;

  return (
    <div className="set-feedback-overlay" role="dialog" aria-modal="true" aria-label={`Set ${props.result.setNo} 回饋`}>
      <div className="set-feedback-dialog">
        <div className="set-feedback-eyebrow">
          Set {props.result.setNo}・{playerWon ? "你拿下了" : "你失去了"}{props.result.kind === "match" ? "・比賽結束" : ""}
        </div>
        <h2>這個 Set，你原本在執行什麼計畫？</h2>
        <p>選一個最主要的原因。這是你的當下假說，Replay 會保留牌面供賽後驗證。</p>

        <div className="set-feedback-grid" aria-label="Set 主要意圖">
          {REPLAY_SET_FEEDBACK_OPTIONS.map((option) => (
            <button
              key={option.tag}
              type="button"
              className={selected === option.tag ? "is-selected" : undefined}
              aria-pressed={selected === option.tag}
              onClick={() => setSelected(option.tag)}
            >
              {option.label}
            </button>
          ))}
        </div>

        {noteOpen ? (
          <label className="set-feedback-note">
            <span>補充文字（選填）</span>
            <textarea
              autoFocus
              maxLength={160}
              value={note}
              placeholder="例如：沒賭到"
              onChange={(event) => setNote(event.target.value)}
            />
            <small>{note.length}/160</small>
          </label>
        ) : (
          <button type="button" className="set-feedback-note-toggle" onClick={() => setNoteOpen(true)}>＋ 補充文字</button>
        )}

        <div className="set-feedback-actions">
          <button type="button" className="btn-secondary" onClick={props.onSkip}>略過</button>
          <button
            type="button"
            data-primary="true"
            disabled={selected === null}
            onClick={() => selected && props.onSubmit(selected, note)}
          >
            保存並繼續
          </button>
        </div>
      </div>
    </div>
  );
}
