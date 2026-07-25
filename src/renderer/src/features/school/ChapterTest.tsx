import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { Key } from 'chessground/types'
import type { Role } from 'chessops/types'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  RotateCcw,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  XCircle
} from 'lucide-react'
import {
  MAX_ATTEMPTS,
  type ChapterTest,
  type TestQuestion,
  type TestRecordResult
} from '@shared/types'
import { Board } from '../../board/Board'
import {
  applyMove,
  checkColor,
  destsFor,
  isPromotion,
  turnColor,
  uciToLastMove,
  type Color
} from '../../chess/chess'
import { ViktorPanel } from './ViktorPanel'
import { annotationsToShapes, SCHOOL_BRUSHES } from './annotations'
import { BoardFrame, EMPTY_DESTS, ROLE_FROM_CHAR, type BoardEnv } from './segments'

// Default pass threshold when a chapter test doesn't set one. The attempt cap is
// owned by the shared contract (@shared/types `MAX_ATTEMPTS`): the SERVER is
// authoritative on attempts/pass/retake; we import that single source of truth
// rather than redefining it here, and use it only for "attempts left" copy.
const PASS_FLOOR = 0.7

export interface ChapterTestProps {
  chapterId: string
  chapterTitle: string
  test: ChapterTest
  env: BoardEnv
  /** Prior attempts already taken (from window.api.school.testState). */
  priorAttempts: number
  /** Already passed previously. Purely informational. */
  alreadyPassed: boolean
  onBack: () => void
  /** Test attempt finished (passed or not); refresh overview state. */
  onFinished: () => void
}

type Phase = 'running' | 'result'

/** What the result screen renders from: the SERVER verdict once recorded, or a
 *  transient pending/error state while the round-trip is in flight or failed. */
type Verdict =
  | { status: 'recording' }
  | { status: 'ready'; result: TestRecordResult }
  | { status: 'error' }

/**
 * The chapter test: questions one at a time under the top progress bar. Score at
 * the end; pass at >= passThreshold. Two attempts total; on a failing attempt we
 * never reveal which answers were right; failing both attempts tells the learner
 * to retake the chapter. Each completed attempt is recorded via recordTest.
 *
 * The SERVER is authoritative on pass/fail + retake: the client sends only the raw
 * scorePct (no `passed`), and the result screen renders from the returned
 * TestRecordResult (result.passed / result.attempts / result.mustRetake /
 * result.bestPct): not from any locally-derived verdict. On a true 2nd fail the
 * server resets the whole chapter, which is reflected by routing the
 * "must retake the chapter" path off result.mustRetake.
 *
 * All hooks run before any early return.
 */
export function ChapterTestView({
  chapterId,
  chapterTitle,
  test,
  env,
  priorAttempts,
  alreadyPassed,
  onBack,
  onFinished
}: ChapterTestProps): JSX.Element {
  const questions = test.questions
  const passThreshold = test.passThreshold ?? PASS_FLOOR

  const [phase, setPhase] = useState<Phase>('running')
  const [qIdx, setQIdx] = useState(0)
  // Correctness per question for THIS attempt (true/false once answered).
  const [marks, setMarks] = useState<boolean[]>([])
  // The server's verdict for this attempt (source of truth for the result screen).
  const [verdict, setVerdict] = useState<Verdict>({ status: 'recording' })
  // The attempt number we are recording (1-based, continuing from prior attempts).
  // An already-passed learner is in practice mode: the chapter is mastered, so the
  // two-attempt lockout doesn't apply and we start a fresh count rather than carrying
  // the prior passing attempt toward "retake the whole chapter".
  const attemptNoRef = useRef(alreadyPassed ? 1 : priorAttempts + 1)
  const recordedRef = useRef(false)
  // Bumped to re-fire the recording effect after an IPC failure ("Try recording
  // again" on the error card).
  const [recordNonce, setRecordNonce] = useState(0)

  const correctCount = useMemo(() => marks.filter(Boolean).length, [marks])
  const scorePct = questions.length > 0 ? correctCount / questions.length : 0

  // Record the attempt exactly once when we reach the result screen and adopt the
  // SERVER verdict as the source of truth (the client no longer sends `passed`).
  // Slice 4 renders result.passed / result.attempts / result.mustRetake /
  // result.bestPct instead of any locally-derived pass/retake.
  useEffect(() => {
    if (phase !== 'result' || recordedRef.current) return
    recordedRef.current = true
    setVerdict({ status: 'recording' })
    const api = window.api?.school
    if (!api?.recordTest) {
      setVerdict({ status: 'error' })
      return
    }
    let cancelled = false
    void api
      .recordTest({
        chapterId,
        scorePct,
        attemptNo: attemptNoRef.current
      })
      .then((result) => {
        if (cancelled) return
        setVerdict({ status: 'ready', result })
      })
      .catch(() => {
        if (cancelled) return
        setVerdict({ status: 'error' })
      })
    return () => {
      cancelled = true
    }
  }, [phase, chapterId, scorePct, recordNonce])

  // A failed round-trip recorded NOTHING server-side: allow re-sending the same
  // attempt rather than rendering a verdict that never happened.
  const retryRecord = useCallback(() => {
    recordedRef.current = false
    setVerdict({ status: 'recording' })
    setRecordNonce((n) => n + 1)
  }, [])

  const onAnswer = useCallback((correct: boolean) => {
    setMarks((m) => [...m, correct])
  }, [])

  const next = useCallback(() => {
    setQIdx((i) => {
      const n = i + 1
      if (n >= questions.length) {
        setPhase('result')
        return i
      }
      return n
    })
  }, [questions.length])

  const retakeTest = useCallback(() => {
    attemptNoRef.current = attemptNoRef.current + 1
    recordedRef.current = false
    setMarks([])
    setQIdx(0)
    setVerdict({ status: 'recording' })
    setPhase('running')
  }, [])

  const progress = phase === 'result' ? 1 : marks.length / Math.max(1, questions.length)

  const topbar = (
    <header className="lesson-top">
      <button className="lesson-back" onClick={onBack}>
        <ArrowLeft size={16} /> Chapter
      </button>
      <div
        className="lesson-progress"
        role="progressbar"
        aria-valuenow={Math.round(progress * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Chapter test progress"
      >
        <div className="lesson-progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
      <span className="lesson-top-label">{chapterTitle} · Test</span>
    </header>
  )

  // -------- RESULT --------
  if (phase === 'result') {
    return (
      <div className="lesson-player">
        {topbar}
        <div className="school-stage school-stage-single">
          <ResultCard
            verdict={verdict}
            scorePct={scorePct}
            correctCount={correctCount}
            totalQuestions={questions.length}
            passThreshold={passThreshold}
            alreadyPassed={alreadyPassed}
            onRetake={retakeTest}
            onRetryRecord={retryRecord}
            onFinished={onFinished}
          />
        </div>
      </div>
    )
  }

  // -------- RUNNING: one question at a time --------
  const q = questions[qIdx]
  return (
    <div className="lesson-player">
      {topbar}
      <QuestionView
        key={qIdx}
        question={q}
        index={qIdx}
        total={questions.length}
        env={env}
        onAnswer={onAnswer}
        onNext={next}
        isLast={qIdx >= questions.length - 1}
      />
    </div>
  )
}

// ===========================================================================
// RESULT CARD: renders the SERVER verdict (TestRecordResult). While the
// round-trip is in flight we show a recording state; on failure we show a
// neutral "not recorded" card (raw score + retry): never a pass/fail verdict
// the server did not issue. result.passed / result.attempts / result.mustRetake
// / result.bestPct are the source of truth.
// ===========================================================================

function ResultCard({
  verdict,
  scorePct,
  correctCount,
  totalQuestions,
  passThreshold,
  alreadyPassed,
  onRetake,
  onRetryRecord,
  onFinished
}: {
  verdict: Verdict
  scorePct: number
  correctCount: number
  totalQuestions: number
  passThreshold: number
  alreadyPassed: boolean
  onRetake: () => void
  onRetryRecord: () => void
  onFinished: () => void
}): JSX.Element {
  // While recording, hold the result screen on a calm pending card. Never flash a
  // (wrong) locally-derived pass/fail before the server speaks.
  if (verdict.status === 'recording') {
    return (
      <div className="test-result-card is-pending" aria-busy="true">
        <span className="test-result-icon" aria-hidden>
          <ShieldCheck size={34} />
        </span>
        <h2 className="test-result-title">Marking your test…</h2>
        <p className="test-result-msg">Viktor is tallying your answers.</p>
      </div>
    )
  }

  // An IPC failure means NOTHING was recorded (no attempt counted, no unlock):
  // never announce a verdict the server did not issue. Show the raw score on a
  // neutral card and offer to send the recording again.
  if (verdict.status === 'error') {
    return (
      <div className="test-result-card is-pending">
        <span className="test-result-icon" aria-hidden>
          <AlertTriangle size={34} />
        </span>
        <h2 className="test-result-title">Could not record this attempt</h2>
        <div className="test-result-score">
          <span className="test-result-pct num">{Math.round(scorePct * 100)}%</span>
          <span className="test-result-frac">
            {correctCount} of {totalQuestions} correct · {Math.round(passThreshold * 100)}% to
            pass
          </span>
        </div>
        <p className="test-result-msg">
          Viktor could not reach the record book, so this attempt has not been marked yet. Try
          recording it again, or return to the chapter and sit the test later.
        </p>
        <div className="test-result-actions">
          <button className="btn school-primary" onClick={onRetryRecord}>
            <RotateCcw size={16} /> Try recording again
          </button>
          <button className="btn ghost school-secondary" onClick={onFinished}>
            Back to chapter
          </button>
        </div>
      </div>
    )
  }

  // Source of truth: the server verdict (recording/error handled above).
  const { result } = verdict
  const passed = result.passed
  const mustRetake = result.mustRetake
  const attempts = result.attempts
  const bestPct = result.bestPct
  const attemptsLeft = Math.max(0, MAX_ATTEMPTS - attempts)
  // After a non-final fail the learner may sit the test again; the next attempt's
  // number is the server's recorded count + 1.
  const nextAttemptNo = attempts + 1
  // Show "best so far" only when it beats this sitting.
  const showBest = bestPct > scorePct + 1e-9

  return (
    <div className={`test-result-card${passed ? ' is-pass' : ' is-fail'}`}>
      <span className="test-result-icon" aria-hidden>
        {passed ? <ShieldCheck size={34} /> : <XCircle size={34} />}
      </span>
      <h2 className="test-result-title">{passed ? 'Test passed' : 'Not passed'}</h2>

      <div className="test-result-score">
        <span className="test-result-pct num">{Math.round(scorePct * 100)}%</span>
        <span className="test-result-frac">
          {correctCount} of {totalQuestions} correct · {Math.round(passThreshold * 100)}% to pass
        </span>
        {showBest && (
          <span className="test-result-best muted small">
            Best so far: {Math.round(bestPct * 100)}%
          </span>
        )}
      </div>

      <p className="test-result-msg">
        {passed
          ? alreadyPassed
            ? 'Cleanly done again. The chapter stays mastered.'
            : 'Strong work. Viktor signs off on this chapter. You may move on.'
          : alreadyPassed
            ? 'Not your sharpest. You have already cleared this chapter, so it stays mastered. Go again whenever you like.'
            : mustRetake
              ? 'That was your final attempt. You must retake the chapter: work back through the lessons, then sit the test again.'
              : `Not yet. You have ${attemptsLeft} attempt${attemptsLeft === 1 ? '' : 's'} left. I will not show you which you missed. Review the lessons and try once more.`}
      </p>

      <div className="test-result-actions">
        {passed ? (
          <button className="btn school-primary" onClick={onFinished}>
            <CheckCircle2 size={16} /> Back to chapter
          </button>
        ) : mustRetake ? (
          <button className="btn school-primary" onClick={onFinished}>
            Back to lessons <ChevronRight size={16} />
          </button>
        ) : (
          <>
            <button className="btn school-primary" onClick={onRetake}>
              <RotateCcw size={16} />{' '}
              {alreadyPassed ? 'Try again' : `Take attempt ${nextAttemptNo}`}
            </button>
            <button className="btn ghost school-secondary" onClick={onFinished}>
              Back to lessons first
            </button>
          </>
        )}
      </div>
    </div>
  )
}

// ===========================================================================
// One question. Renders by kind; reports correctness up, then offers Next.
// During the test we never reveal correctness inline (answers hidden on fail),
// so feedback is a neutral "Answer recorded" until the result screen.
// ===========================================================================

type QPhase = 'answering' | 'answered'

function promoRoleFor(uci: string): Role | undefined {
  return uci.length > 4 ? ROLE_FROM_CHAR[uci[4]] : undefined
}

function QuestionView({
  question,
  index,
  total,
  env,
  onAnswer,
  onNext,
  isLast
}: {
  question: TestQuestion
  index: number
  total: number
  env: BoardEnv
  onAnswer: (correct: boolean) => void
  onNext: () => void
  isLast: boolean
}): JSX.Element {
  const [phase, setPhase] = useState<QPhase>('answering')

  // Board state for play/judge questions.
  const baseFen =
    question.kind === 'play' || question.kind === 'judge' ? question.fen : (question.fen ?? '')
  const [boardFen, setBoardFen] = useState(baseFen)
  const [lastMove, setLastMove] = useState<[Key, Key] | undefined>(
    question.kind === 'judge' ? uciToLastMove(question.lastMoveUci) : undefined
  )
  const [nonce, setNonce] = useState(0)
  const [selected, setSelected] = useState<number | null>(null)
  // Multi-ply play ("play the opening out"): which line-step the learner is on, and
  // whether an opponent reply is currently auto-playing (board locked during it).
  const [stepIdx, setStepIdx] = useState(0)
  const [replying, setReplying] = useState(false)
  const replyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Multi-ply script (only for play questions that carry `line`). When absent, the
  // single-ply `solutionUci` path drives the question (back-compat).
  const line = question.kind === 'play' ? question.line : undefined
  const isMultiPly = Array.isArray(line) && line.length > 0

  // Clean up any pending auto-reply timer on unmount.
  useEffect(() => {
    return () => {
      if (replyTimer.current) clearTimeout(replyTimer.current)
    }
  }, [])

  const orientation: Color = useMemo(() => (baseFen ? turnColor(baseFen) : 'white'), [baseFen])
  const dests = useMemo(
    () =>
      question.kind === 'play' && phase === 'answering' && !replying && boardFen
        ? destsFor(boardFen)
        : EMPTY_DESTS,
    [question.kind, phase, replying, boardFen]
  )
  const turn = useMemo(() => (boardFen ? turnColor(boardFen) : 'white'), [boardFen])
  const check = useMemo(() => (boardFen ? checkColor(boardFen) : undefined), [boardFen])

  // The move to judge, in the school annotation language (amber focus arrow).
  const judgeShapes = useMemo(() => {
    if (question.kind !== 'judge') return []
    const [from, to] = uciToLastMove(question.lastMoveUci)
    return annotationsToShapes([{ kind: 'arrow', from, to, color: 'focus' }])
  }, [question])

  const commit = useCallback(
    (correct: boolean) => {
      setPhase('answered')
      onAnswer(correct)
    },
    [onAnswer]
  )

  // ---- play: single-ply. Accept any of solutionUci, matched on from/to ----
  // The board has no promotion picker, so the solution itself supplies the
  // promotion piece (underpromotions like 'e7e8n' included). A WRONG move that is
  // itself a promotion push still needs a role to be legal: apply it as a queen so
  // the miss commits instead of snapping back forever.
  const onSinglePlyMove = useCallback(
    (orig: Key, dest: Key) => {
      if (question.kind !== 'play') return
      const plain = `${orig}${dest}`
      const matched = question.solutionUci.find((s) => s.slice(0, 4) === plain)
      const promo = matched ? promoRoleFor(matched) : undefined
      const applied =
        applyMove(boardFen, orig, dest, promo) ??
        (isPromotion(boardFen, orig, dest) ? applyMove(boardFen, orig, dest, 'queen') : null)
      if (!applied) {
        setNonce((n) => n + 1)
        return
      }
      // Show the played move regardless, then record correctness (hidden).
      setBoardFen(applied.fen)
      setLastMove(uciToLastMove(applied.uci))
      commit(Boolean(matched))
    },
    [question, boardFen, commit]
  )

  // ---- play: multi-ply, "play the opening out" step loop ----
  // Each step accepts any of step.userUci (queen-promo tolerant); on a match we play
  // it, auto-play step.replyUci, advance to the next step, and only mark the whole
  // question correct once every step is satisfied. A wrong (legal) move fails the
  // whole question immediately (answers stay hidden, single shot; same as single-ply).
  const onMultiPlyMove = useCallback(
    (orig: Key, dest: Key) => {
      if (question.kind !== 'play' || !line || replying) return
      const step = line[stepIdx]
      if (!step) return
      const plain = `${orig}${dest}`
      // From/to match: the scripted move supplies any promotion piece.
      const matched = step.userUci.find((s) => s.slice(0, 4) === plain)

      if (!matched) {
        // Legal but wrong move ends the question as failed; show what was played.
        // A wrong promotion push needs a role to be legal. Apply it as a queen so
        // it commits as a miss instead of snapping back for free retries.
        const played =
          applyMove(boardFen, orig, dest) ??
          (isPromotion(boardFen, orig, dest) ? applyMove(boardFen, orig, dest, 'queen') : null)
        if (!played) {
          setNonce((n) => n + 1)
          return
        }
        setBoardFen(played.fen)
        setLastMove(uciToLastMove(played.uci))
        commit(false)
        return
      }

      const applied = applyMove(boardFen, orig, dest, promoRoleFor(matched))
      if (!applied) {
        setNonce((n) => n + 1)
        return
      }
      setBoardFen(applied.fen)
      setLastMove(uciToLastMove(applied.uci))

      const isLastStep = stepIdx >= line.length - 1
      const reply = step.replyUci

      if (!reply) {
        // No opponent reply scripted for this step: advance (or finish), but only
        // if the board is still the learner's to move. Advancing onto the
        // opponent's turn with no scripted reply would dead-lock the question, so
        // treat that as an authoring error and credit the line instead.
        if (isLastStep) {
          commit(true)
        } else if (turnColor(applied.fen) === orientation) {
          setStepIdx((i) => i + 1)
        } else {
          console.warn(
            `ChapterTest: line step ${stepIdx} has no replyUci but leaves the opponent on move. Treating the line as complete.`
          )
          commit(true)
        }
        return
      }

      // Auto-play the opponent's reply, then advance (or finish if it was the last).
      setReplying(true)
      replyTimer.current = setTimeout(() => {
        replyTimer.current = null
        const afterReply = applyMove(
          applied.fen,
          reply.slice(0, 2),
          reply.slice(2, 4),
          promoRoleFor(reply)
        )
        setReplying(false)
        if (afterReply) {
          setBoardFen(afterReply.fen)
          setLastMove(uciToLastMove(afterReply.uci))
        }
        if (isLastStep) {
          commit(true)
        } else {
          setStepIdx((i) => i + 1)
        }
      }, 340)
    },
    [question, line, replying, stepIdx, boardFen, orientation, commit]
  )

  const onPlayMove = isMultiPly ? onMultiPlyMove : onSinglePlyMove

  const counter = (
    <span className="school-step-count">
      Question {index + 1} / {total}
    </span>
  )

  const nextBtn =
    phase === 'answered' ? (
      <button className="btn school-primary" onClick={onNext}>
        {isLast ? 'Finish test' : 'Next question'} <ChevronRight size={16} />
      </button>
    ) : null

  const answeredChip =
    phase === 'answered' ? <span className="school-tag is-task">Answer recorded</span> : null

  // -------- MULTIPLE CHOICE --------
  if (question.kind === 'mc') {
    const showBoard = Boolean(question.fen)
    return (
      <div className={`school-stage${showBoard ? '' : ' school-stage-single'}`}>
        {showBoard && (
          <BoardFrame env={env}>
            <Board
              fen={question.fen as string}
              orientation={orientation}
              turnColor={turn}
              dests={EMPTY_DESTS}
              viewOnly
              check={check}
              coordinates={env.coordinates}
              animation={env.animation}
            />
          </BoardFrame>
        )}
        <ViktorPanel text={question.prompt} eyebrow={`Key idea (Q${index + 1})`}>
          <div className="school-step-meta">{counter}</div>
          <ul className="test-mc-options" role="listbox" aria-label="Answer choices">
            {question.options.map((opt, i) => (
              <li key={i}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected === i}
                  className={`test-mc-option${selected === i ? ' is-selected' : ''}`}
                  disabled={phase === 'answered'}
                  onClick={() => {
                    setSelected(i)
                    commit(i === question.answerIndex)
                  }}
                >
                  <span className="test-mc-key">{String.fromCharCode(65 + i)}</span>
                  <span className="test-mc-text">{opt}</span>
                </button>
              </li>
            ))}
          </ul>
          {answeredChip}
          {nextBtn}
        </ViktorPanel>
      </div>
    )
  }

  // -------- PLAY --------
  if (question.kind === 'play') {
    const eyebrow = isMultiPly ? `Play it out (Q${index + 1})` : `Play it (Q${index + 1})`
    return (
      <div className="school-stage">
        <BoardFrame env={env}>
          <Board
            fen={boardFen}
            orientation={orientation}
            turnColor={turn}
            dests={dests}
            movableColor={orientation}
            viewOnly={phase !== 'answering'}
            lastMove={lastMove}
            check={check}
            showDests={env.showDests}
            coordinates={env.coordinates}
            animation={env.animation}
            onMove={onPlayMove}
            syncNonce={nonce}
          />
        </BoardFrame>
        <ViktorPanel text={question.prompt} eyebrow={eyebrow}>
          <div className="school-step-meta">
            {counter}
            {isMultiPly && line && phase === 'answering' && (
              <span className="school-step-count">
                Move {Math.min(stepIdx + 1, line.length)} / {line.length}
              </span>
            )}
            {phase === 'answering' && (
              <span className="school-tag is-task">{replying ? 'Reply…' : 'Your move'}</span>
            )}
            {answeredChip}
          </div>
          {nextBtn}
        </ViktorPanel>
      </div>
    )
  }

  // -------- JUDGE: was the highlighted move correct or a blunder? --------
  return (
    <div className="school-stage">
      <BoardFrame env={env}>
        <Board
          fen={question.fen}
          orientation={orientation}
          turnColor={turn}
          dests={EMPTY_DESTS}
          viewOnly
          lastMove={lastMove}
          check={check}
          shapes={judgeShapes}
          brushes={SCHOOL_BRUSHES}
          coordinates={env.coordinates}
          animation={env.animation}
        />
      </BoardFrame>
      <ViktorPanel text={question.prompt} eyebrow={`Judge it (Q${index + 1})`}>
        <div className="school-step-meta">
          {counter}
          {answeredChip}
        </div>
        {phase === 'answering' ? (
          <div className="test-judge-row">
            <button
              type="button"
              className="btn test-judge-btn is-correct"
              onClick={() => commit(question.verdict === 'correct')}
            >
              <ThumbsUp size={16} /> Correct
            </button>
            <button
              type="button"
              className="btn test-judge-btn is-blunder"
              onClick={() => commit(question.verdict === 'blunder')}
            >
              <ThumbsDown size={16} /> Blunder
            </button>
          </div>
        ) : (
          nextBtn
        )}
      </ViktorPanel>
    </div>
  )
}

export default ChapterTestView
