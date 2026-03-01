;; Test 4: Deferred (async) host import.
;;
;; The component imports `slow-compute` from the host (returns a Promise),
;; lowers it with `async` (creating a subtask), waits for completion
;; via waitable-set + WAIT callback code, then returns ok.
;;
;; Uses context storage to remember the waitable-set index across callbacks.

(component
  (type $result-type (result))

  ;; Import an async function from the host (may return a Promise)
  (import "slow-compute" (func $slow-compute (result u32)))

  ;; Memory module — needed for `canon lower ... async`
  (core module $mem-mod (memory (export "memory") 1))
  (core instance $mem-inst (instantiate $mem-mod))

  ;; Lower the import with `async`
  (core func $lowered-slow-compute
    (canon lower (func $slow-compute) async (memory $mem-inst "memory")))

  (core module $m
    (import "mem" "memory" (memory 1))
    (import "" "task.return" (func $task.return (param i32)))
    (import "" "context.get" (func $context.get (result i32)))
    (import "" "context.set" (func $context.set (param i32)))
    ;; Async lowered: (result_ptr: i32) -> (subtask_packed: i32)
    (import "" "slow-compute" (func $slow-compute (param i32) (result i32)))
    (import "" "waitable-set.new" (func $ws.new (result i32)))
    (import "" "waitable.join" (func $w.join (param i32 i32)))
    (import "" "subtask.drop" (func $st.drop (param i32)))

    (func (export "run") (result i32)
      (local $subtask_packed i32)
      (local $subtask_handle i32)
      (local $subtask_state i32)
      (local $ws i32)

      ;; Call the async import — pass result_ptr=0
      (local.set $subtask_packed (call $slow-compute (i32.const 0)))
      (local.set $subtask_handle (i32.shr_u (local.get $subtask_packed) (i32.const 4)))
      (local.set $subtask_state (i32.and (local.get $subtask_packed) (i32.const 0xf)))

      ;; If already RETURNED (state >= 2), skip the wait
      (local.get $subtask_state)
      (i32.const 2)
      (i32.ge_u)
      (if
        (then
          (call $st.drop (local.get $subtask_handle))
          (call $task.return (i32.const 0))
          (return (i32.const 0))  ;; EXIT
        )
      )

      ;; Not done yet — create a waitable-set, join subtask to it
      (local.set $ws (call $ws.new))
      (call $w.join (local.get $subtask_handle) (local.get $ws))

      ;; Store ws index in context[0] so the callback can use it
      (call $context.set (local.get $ws))

      ;; Return WAIT | (ws << 4)
      (i32.or
        (i32.shl (local.get $ws) (i32.const 4))
        (i32.const 2))  ;; WAIT code
    )

    (func (export "run-cb") (param $event i32) (param $p1 i32) (param $p2 i32) (result i32)
      ;; Event: $event = event code, $p1 = waitable handle, $p2 = payload (state)
      ;; SUBTASK event: $p2 = new subtask state

      ;; If state >= RETURNED (2), we're done
      (local.get $p2)
      (i32.const 2)
      (i32.ge_u)
      (if (result i32)
        (then
          ;; Drop the subtask, return ok, EXIT
          (call $st.drop (local.get $p1))
          (call $task.return (i32.const 0))
          (i32.const 0))  ;; EXIT
        (else
          ;; Not done — WAIT again on the same waitable-set
          ;; Retrieve ws index from context[0]
          (i32.or
            (i32.shl (call $context.get) (i32.const 4))
            (i32.const 2)))  ;; WAIT code
      )
    )
  )

  (canon task.return (result $result-type) (core func $task.return))
  (core func $context.get (canon context.get i32 0))
  (core func $context.set (canon context.set i32 0))
  (canon waitable-set.new (core func $ws.new))
  (canon waitable.join (core func $w.join))
  (canon subtask.drop (core func $st.drop))

  (core instance $i (instantiate $m
    (with "mem" (instance $mem-inst))
    (with "" (instance
      (export "task.return" (func $task.return))
      (export "context.get" (func $context.get))
      (export "context.set" (func $context.set))
      (export "slow-compute" (func $lowered-slow-compute))
      (export "waitable-set.new" (func $ws.new))
      (export "waitable.join" (func $w.join))
      (export "subtask.drop" (func $st.drop))
    ))
  ))

  (type $run-type (func async (result $result-type)))
  (alias core export $i "run" (core func $run))
  (alias core export $i "run-cb" (core func $run-cb))
  (func $run (type $run-type) (canon lift (core func $run) async (callback (func $run-cb))))

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
