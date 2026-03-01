;; Test: exit-immediate — async export that returns EXIT immediately.
;;
;; The simplest possible async export: the entry function calls task.return
;; and returns EXIT (0) without ever yielding or waiting.
;; This tests instant completion (no suspension needed).

(component
  (type $result-type (result))

  (core module $m
    (import "" "task.return" (func $task.return (param i32)))

    ;; Entry function: call task.return(0) = ok, then return EXIT (0)
    (func (export "run") (result i32)
      (call $task.return (i32.const 0))  ;; task.return with discriminant 0 (ok)
      (i32.const 0))                     ;; EXIT

    ;; Callback: should never be called for EXIT-immediate
    (func (export "run-cb") (param i32 i32 i32) (result i32)
      (unreachable))
  )

  (canon task.return (result $result-type) (core func $task.return))

  (core instance $i (instantiate $m (with "" (instance
    (export "task.return" (func $task.return))
  ))))

  (type $run-type (func async (result $result-type)))
  (alias core export $i "run" (core func $run))
  (alias core export $i "run-cb" (core func $run-cb))
  (func $run (type $run-type) (canon lift (core func $run) async (callback (func $run-cb))))

  ;; Export through wasi:cli/run shim
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
