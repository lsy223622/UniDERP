package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestPreparedModuleUsesRootSecurityDependencies(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	work := t.TempDir()
	if err := os.WriteFile(filepath.Join(work, "go.mod"), []byte("module example.com/prepared\n\ngo 1.26.6\n\nrequire (\n golang.org/x/crypto v0.54.0\n golang.org/x/net v0.56.0\n)\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := prepareDependencies(root, work); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{
		{"list", "-m", "-f", "{{.GoVersion}}"},
		{"list", "-m", "-f", "{{.Path}}@{{.Version}}", "golang.org/x/crypto", "golang.org/x/net"},
	} {
		read := func(dir string) string {
			cmd := exec.Command("go", args...)
			cmd.Dir = dir
			data, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("%v: %v\n%s", args, err, data)
			}
			return strings.TrimSpace(string(data))
		}
		if got, want := read(work), read(root); got != want {
			t.Fatalf("prepared module differs from root: got %q, want %q", got, want)
		}
	}
}

func TestRejectsChangedUpstreamPin(t *testing.T) {
	for _, change := range []func(*sourceInfo){
		func(s *sourceInfo) { s.Version = "v1.102.4" },
		func(s *sourceInfo) { s.Origin.Hash = strings.Repeat("0", 40) },
		func(s *sourceInfo) { s.Sum = "h1:wrong" },
	} {
		s := sourceInfo{Version: upstreamVersion, Sum: upstreamSum}
		s.Origin.Hash = upstreamCommit
		change(&s)
		if err := validateSource(s); err == nil {
			t.Fatal("accepted changed source pin")
		}
	}
}

func TestRejectsPatchNotApplied(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "derp", "derpserver")
	if err := os.MkdirAll(path, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(path, "derpserver.go"), []byte("package derpserver\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := verifyApplied(dir); err == nil {
		t.Fatal("accepted unpatched source")
	}
}
