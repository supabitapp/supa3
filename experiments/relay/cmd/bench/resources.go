package main

import (
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type resource struct {
	At         string  `json:"at"`
	CPUSeconds float64 `json:"cpuSeconds"`
	RSSKiB     int64   `json:"rssKiB"`
}

func readResource(pid int) (resource, error) {
	output, err := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", "rss=", "-o", "time=").Output()
	if err != nil {
		return resource{}, err
	}
	fields := strings.Fields(string(output))
	if len(fields) != 2 {
		return resource{}, fmt.Errorf("unexpected process resource output")
	}
	rss, err := strconv.ParseInt(fields[0], 10, 64)
	if err != nil {
		return resource{}, err
	}
	cpu := 0.0
	for _, part := range strings.Split(fields[1], ":") {
		v, err := strconv.ParseFloat(part, 64)
		if err != nil {
			return resource{}, err
		}
		cpu = cpu*60 + v
	}
	return resource{time.Now().UTC().Format(time.RFC3339Nano), cpu, rss}, nil
}

func systemInfo() map[string]string {
	values := map[string]string{}
	for _, query := range []struct {
		name, cmd string
		args      []string
	}{{"uname", "uname", []string{"-a"}}, {"hardware", "sysctl", []string{"-n", "machdep.cpu.brand_string"}}, {"memoryBytes", "sysctl", []string{"-n", "hw.memsize"}}} {
		if out, err := exec.Command(query.cmd, query.args...).Output(); err == nil {
			values[query.name] = strings.TrimSpace(string(out))
		}
	}
	return values
}
