# Stepsemble 3.0.53 — One Claude conversation appears once

## Issue and change

A single Claude conversation could appear several times in the session list,
and a prompt sent to it could go unanswered.

Two defects combined. Opening a Claude conversation always launched a new
process, even when that exact conversation was already attached, so several
live sessions shared one native conversation id and each of them received the
same prompt. Codex already guarded against this; Claude did not.

The task snapshot then de-duplicated on the task id. The same conversation is
described by a live bridge, by the resume registry and by a local history scan,
each under a different task id, so the duplicates survived. The history merge
compared only `nativeSessionId`, missing rows that carry
`nativeHistorySessionId` instead.

Resuming an attached conversation now returns the existing session, and the
snapshot de-duplicates on the native conversation id across all three sources,
matching either identifier. A live session wins over an ended record because it
carries current state.

## Validation

- Full local suite: 1,456 passed, 4 skipped, 0 failed (1,460 tests).
- New regression drives a real turn, resumes the conversation by its native id,
  and asserts the existing task is returned and the conversation is listed once.
- Observed on the Mac Mini before the fix: three live sessions shared native id
  `63197045-…`, with four Claude stream processes running.

## Explicit boundaries

- This does not delete existing history records. Rows already written by an
  earlier duplicate remain until their source rotates them out.
- It does not change how a conversation is resumed or how history is read.
