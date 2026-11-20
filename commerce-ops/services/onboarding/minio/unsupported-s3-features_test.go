package cmd

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRocentoUnsupportedS3FeaturesDeniedBeforeHandler(t *testing.T) {
	for _, tc := range []struct {
		name   string
		method string
		path   string
		header http.Header
	}{
		{"select", http.MethodPost, "/fixture/object?select&select-type=2", nil},
		{"select-reordered", http.MethodPost, "/fixture/object?select-type=2&select=", nil},
		{"select-encoded-key", http.MethodPost, "/fixture/object?%73elect&select-type=2", nil},
		{"select-duplicate-key", http.MethodPost, "/fixture/object?select=fixture&select=&select-type=2", nil},
		{"select-other-method", http.MethodGet, "/fixture/object?select", nil},
		{"select-without-type", http.MethodPost, "/fixture/object?select", nil},
		{"replication-sse", http.MethodPut, "/fixture/object", http.Header{"X-Minio-Replication-Server-Side-Encryption-Iv": {"disabled-feature-fixture"}}},
		{"replication-multipart", http.MethodPut, "/fixture/object", http.Header{"X-Minio-Replication-Encrypted-Multipart": {"disabled-feature-fixture"}}},
		{"replication-size", http.MethodPut, "/fixture/object", http.Header{"X-Minio-Replication-Actual-Object-Size": {"disabled-feature-fixture"}}},
		{"replication-marker", http.MethodPut, "/fixture/object", http.Header{"X-Minio-Source-Replication-Request": {"disabled-feature-fixture"}}},
		{"replication-marker-and-header", http.MethodPut, "/fixture/object", http.Header{"X-Minio-Source-Replication-Request": {"disabled-feature-fixture"}, "X-Minio-Replication-Server-Side-Encryption-Iv": {"disabled-feature-fixture"}}},
		{"replication-lowercase-name", http.MethodPut, "/fixture/object", http.Header{"x-minio-replication-server-side-encryption-iv": {"disabled-feature-fixture"}}},
		{"replication-empty-value", http.MethodPut, "/fixture/object", http.Header{"X-Minio-Replication-Server-Side-Encryption-Iv": {""}}},
		{"replication-get", http.MethodGet, "/fixture/object", http.Header{"X-Minio-Replication-Actual-Object-Size": {"disabled-feature-fixture"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, tc.path, strings.NewReader("ordinary fixture content"))
			if tc.header != nil {
				r.Header = tc.header
			}
			called := false
			w := httptest.NewRecorder()
			setAuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				w.WriteHeader(http.StatusNoContent)
			})).ServeHTTP(w, r)
			if called {
				t.Fatal("unsupported S3 feature reached downstream handler")
			}
			want := errorCodes.ToAPIErr(ErrNotImplemented)
			if w.Code != want.HTTPStatusCode || !strings.Contains(w.Body.String(), "<Code>"+want.Code+"</Code>") {
				t.Fatalf("unexpected feature-denial status/code: %d", w.Code)
			}
		})
	}
}

func TestRocentoUnsupportedS3FeaturesOrdinaryRequestsReachHandler(t *testing.T) {
	for _, tc := range []struct {
		name   string
		path   string
		header http.Header
	}{
		{"ordinary-object", "/fixture/object", nil},
		{"select-in-object-name", "/fixture/select", nil},
		{"select-in-query-value", "/fixture?prefix=select", nil},
		{"multipart-route", "/fixture/object?partNumber=1&uploadId=fixture", nil},
		{"content-type", "/fixture/object", http.Header{"Content-Type": {"image/png"}}},
		{"ordinary-user-metadata", "/fixture/object", http.Header{"X-Amz-Meta-Description": {"ordinary fixture"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPut, tc.path, nil)
			if tc.header != nil {
				r.Header = tc.header
			}
			called := false
			w := httptest.NewRecorder()
			setAuthMiddleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				called = true
				w.WriteHeader(http.StatusNoContent)
			})).ServeHTTP(w, r)
			if !called || w.Code != http.StatusNoContent {
				t.Fatalf("ordinary request blocked by middleware: %d", w.Code)
			}
		})
	}
}
