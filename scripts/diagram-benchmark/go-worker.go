package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"time"

	"github.com/AlexanderGrooff/mermaid-ascii/pkg/diagram"
	"github.com/AlexanderGrooff/mermaid-ascii/pkg/render"
	"github.com/gookit/color"
)

var version string

type response struct {
	Output   *string `json:"output,omitempty"`
	Error    string  `json:"error,omitempty"`
	RenderMs float64 `json:"renderMs"`
}

func renderSource(source string) (result response) {
	started := time.Now()
	defer func() {
		result.RenderMs = float64(time.Since(started)) / float64(time.Millisecond)
		if recovered := recover(); recovered != nil {
			result.Error = fmt.Sprintf("render panic: %v", recovered)
			result.Output = nil
		}
	}()
	output, err := render.RenderDiagram(source, diagram.DefaultConfig())
	if err != nil {
		result.Error = err.Error()
	} else {
		result.Output = &output
	}
	return
}

func main() {
	encoder := json.NewEncoder(os.Stdout)
	os.Stdout = os.Stderr
	color.Disable()
	if err := encoder.Encode(struct {
		Ready    bool   `json:"ready"`
		Renderer string `json:"renderer"`
		Version  string `json:"version"`
	}{true, "mermaid-ascii", version}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		var request struct {
			Source *string `json:"source"`
		}
		var result response
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			result.Error = err.Error()
		} else if request.Source == nil {
			result.Error = "source must be a string"
		} else {
			result = renderSource(*request.Source)
		}
		if err := encoder.Encode(result); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
