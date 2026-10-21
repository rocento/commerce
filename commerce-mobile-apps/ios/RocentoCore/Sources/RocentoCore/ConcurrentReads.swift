import Foundation

/// Bounds independent read fan-out, preserves input order, and cancels siblings on failure.
func concurrentReads<Input: Sendable, Output: Sendable>(
  _ inputs: [Input], limit: Int = 4,
  operation: @escaping @Sendable (Input) async throws -> Output
) async throws -> [Output] {
  try await withThrowingTaskGroup(of: (Int, Output).self) { group in
    var next = 0
    func enqueue(_ index: Int) {
      let input = inputs[index]
      group.addTask { try Task.checkCancellation(); return (index, try await operation(input)) }
    }
    while next < min(max(1, limit), inputs.count) { enqueue(next); next += 1 }
    var results: [(Int, Output)] = []
    for try await result in group {
      try Task.checkCancellation()
      results.append(result)
      if next < inputs.count { enqueue(next); next += 1 }
    }
    return results.sorted { $0.0 < $1.0 }.map(\.1)
  }
}
