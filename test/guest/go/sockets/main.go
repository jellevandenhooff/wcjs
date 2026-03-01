package main

import (
	"fmt"
	"net"
	"os"
)

func main() {
	// Create a TCP listener on localhost with an ephemeral port
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fmt.Printf("listen error: %v\n", err)
		os.Exit(1)
	}
	defer ln.Close()
	fmt.Printf("listening on %s\n", ln.Addr().String())

	// Dial from a goroutine
	done := make(chan error, 1)
	go func() {
		conn, err := net.Dial("tcp", ln.Addr().String())
		if err != nil {
			done <- fmt.Errorf("dial error: %w", err)
			return
		}
		defer conn.Close()

		// Send data
		_, err = conn.Write([]byte("hello sockets"))
		if err != nil {
			done <- fmt.Errorf("write error: %w", err)
			return
		}
		done <- nil
	}()

	// Accept connection
	conn, err := ln.Accept()
	if err != nil {
		fmt.Printf("accept error: %v\n", err)
		os.Exit(1)
	}
	defer conn.Close()
	fmt.Println("accepted connection")

	// Read data
	buf := make([]byte, 1024)
	n, err := conn.Read(buf)
	if err != nil {
		fmt.Printf("read error: %v\n", err)
		os.Exit(1)
	}
	msg := string(buf[:n])
	fmt.Printf("received: %s\n", msg)

	// Wait for sender goroutine
	if err := <-done; err != nil {
		fmt.Printf("sender error: %v\n", err)
		os.Exit(1)
	}

	if msg != "hello sockets" {
		fmt.Printf("unexpected message: %q\n", msg)
		os.Exit(1)
	}

	fmt.Println("all socket tests passed")
}
