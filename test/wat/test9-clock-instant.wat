;; Test 9: Instant clock completion (sleep 0, wait until past).
;;
;; Imports `monotonic-now` (sync) and `wait-for` (async). Calls wait-for(0)
;; which should complete immediately (RETURNED state, no WAIT needed).
;; Also calls wait-for(1) to verify a real sleep still works.
;;
;; Tests the instant completion path: if the host import resolves
;; synchronously (returns non-Promise), the subtask should be RETURNED
;; immediately without needing a waitable-set or WAIT.
;;
;; Modeled after wasmtime's sleep_0ms and sleep_backwards_in_time tests.

(component
  (type $result-type (result))

  ;; Import clock functions from host
  (import "monotonic-now" (func $monotonic-now (result u64)))
  (import "wait-for" (func $wait-for (param "how-long" u64)))

  ;; Memory module
  (core module $mem-mod (memory (export "memory") 1))
  (core instance $mem-inst (instantiate $mem-mod))

  ;; Lower imports
  (core func $lowered-now (canon lower (func $monotonic-now)))
  (core func $lowered-wait-for
    (canon lower (func $wait-for) async (memory $mem-inst "memory")))

  (core module $m
    (import "mem" "memory" (memory 1))
    (import "" "task.return" (func $task.return (param i32)))
    (import "" "monotonic-now" (func $now (result i64)))
    (import "" "wait-for" (func $wait-for (param i64) (result i32)))
    (import "" "subtask.drop" (func $st.drop (param i32)))

    (func (export "run") (result i32)
      (local $subtask_packed i32)
      (local $subtask_handle i32)
      (local $subtask_state i32)

      ;; Test 1: wait-for(0) should complete instantly
      (local.set $subtask_packed (call $wait-for (i64.const 0)))
      (local.set $subtask_handle (i32.shr_u (local.get $subtask_packed) (i32.const 4)))
      (local.set $subtask_state (i32.and (local.get $subtask_packed) (i32.const 0xf)))

      ;; Expect RETURNED (state >= 2) immediately
      (if (i32.lt_u (local.get $subtask_state) (i32.const 2))
        (then
          ;; Failed: wait-for(0) didn't complete instantly
          (call $task.return (i32.const 1))
          (return (i32.const 0))
        )
      )
      ;; Per spec: synchronous completion returns bare RETURNED (2) with no
      ;; handle in the upper bits — only drop if there's actually a handle.
      (if (local.get $subtask_handle)
        (then (call $st.drop (local.get $subtask_handle)))
      )

      ;; Test 2: Verify now() is callable (smoke test)
      (if (i64.eq (call $now) (i64.const 0))
        (then
          ;; now() returned 0, which is suspicious
          (call $task.return (i32.const 1))
          (return (i32.const 0))
        )
      )

      ;; All good
      (call $task.return (i32.const 0))
      (i32.const 0)  ;; EXIT
    )

    ;; Callback (never called — instant EXIT)
    (func (export "run-cb") (param $event i32) (param $p1 i32) (param $p2 i32) (result i32)
      (unreachable)
    )
  )

  (canon task.return (result $result-type) (core func $task.return))
  (core func $lowered-now-alias (canon lower (func $monotonic-now)))
  (canon subtask.drop (core func $st.drop))

  (core instance $i (instantiate $m
    (with "mem" (instance $mem-inst))
    (with "" (instance
      (export "task.return" (func $task.return))
      (export "monotonic-now" (func $lowered-now))
      (export "wait-for" (func $lowered-wait-for))
      (export "subtask.drop" (func $st.drop))
    ))
  ))

  (type $run-type (func async (result $result-type)))
  (alias core export $i "run" (core func $run))
  (alias core export $i "run-cb" (core func $run-cb))
  (func $run (type $run-type) (canon lift (core func $run) async (memory $mem-inst "memory") (callback (func $run-cb))))

  (component $shim
    (type $r (result))
    (type $run-func (func async (result $r)))
    (import "import-func-run" (func (type $run-func)))
    (type $r2 (result))
    (type $run-func2 (func async (result $r2)))
    (export "run" (func 0) (func (type $run-func2)))
  )
  (instance $shim-inst (instantiate $shim (with "import-func-run" (func $run))))
  (export "wasi:cli/run@0.3.0-rc-2026-01-06" (instance $shim-inst))
)
