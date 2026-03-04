mod bindings {
    wit_bindgen::generate!({
        path: "wit",
        world: "multi-export",
        async: [
            "import:test:multi/host#double",
            "export:test:multi/math#double-add",
            "export:test:multi/greeter#greet",
        ],
    });
    use super::Component;
    export!(Component);
}

use bindings::test::multi::host;

struct Component;

impl bindings::exports::test::multi::math::Guest for Component {
    fn add(a: u32, b: u32) -> u32 {
        a + b
    }

    async fn double_add(a: u32, b: u32) -> u32 {
        let (da, db) = futures::join!(host::double(a), host::double(b));
        da + db
    }
}

impl bindings::exports::test::multi::greeter::Guest for Component {
    async fn greet(name: String) -> String {
        let doubled = host::double(name.len() as u32).await;
        format!("Hello, {}! ({})", name, doubled)
    }
}
