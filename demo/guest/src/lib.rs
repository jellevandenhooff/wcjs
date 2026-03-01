mod bindings {
    wit_bindgen::generate!({
        path: "wit",
        world: "calculator",
        async: [
            "import:demo:calculator/host#slow-double",
            "export:demo:calculator/calc#double-and-add",
        ],
    });
    use super::Component;
    export!(Component);
}

use bindings::demo::calculator::host;

struct Component;

impl bindings::exports::demo::calculator::calc::Guest for Component {
    fn add(a: i32, b: i32) -> i32 {
        a + b
    }

    async fn double_and_add(a: u32, b: u32) -> u32 {
        host::log(&format!("double-and-add({a}, {b}) — calling slow-double concurrently"));
        let (da, db) = futures::join!(host::slow_double(a), host::slow_double(b));
        host::log(&format!("  => {da} + {db} = {}", da + db));
        da + db
    }
}
