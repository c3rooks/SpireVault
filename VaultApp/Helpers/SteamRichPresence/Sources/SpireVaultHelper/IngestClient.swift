// IngestClient — POSTs helper state to the worker's
// /coop/rich-presence/ingest endpoint.
//
// Wire format mirrors `RichPresenceIngestBody` in
// Backend/src/coop-rich-presence.ts. The server returns a plan
// (`{ applied, status, activityDetail }`) which the helper currently
// logs but doesn't act on — the heartbeat tick simply re-reports on
// the cadence above. v0.13 may consume the plan to skip duplicate
// reports.

import Foundation

struct IngestRequestBody: Encodable {
  let helperVersion: String
  let hostOS: String
  let state: String
  let stsAppId: Int
  let activityDetail: String?
  let reportedAt: String
}

enum IngestError: Error, LocalizedError {
  case http(Int)
  case transport(any Error)
  case noToken
  case malformedResponse

  var errorDescription: String? {
    switch self {
    case .http(let s):     return "HTTP \(s) from /coop/rich-presence/ingest"
    case .transport(let e): return "Transport: \(e.localizedDescription)"
    case .noToken:         return "No session token available"
    case .malformedResponse: return "Malformed response body"
    }
  }
}

final class IngestClient {
  private let baseURL: URL
  private let sessionToken: String
  private let urlSession: URLSession

  init(baseURL: URL, sessionToken: String) {
    self.baseURL = baseURL
    self.sessionToken = sessionToken
    let cfg = URLSessionConfiguration.ephemeral
    cfg.timeoutIntervalForRequest = 15
    cfg.timeoutIntervalForResource = 30
    cfg.waitsForConnectivity = true
    cfg.httpAdditionalHeaders = [
      "User-Agent": "SpireVaultHelper/\(HelperOptions.version) (macOS)",
    ]
    self.urlSession = URLSession(configuration: cfg)
  }

  func send(
    state: SteamState,
    activityDetail: String?,
    reportedAt: Date,
    helperVersion: String,
    hostOS: String,
    stsAppId: Int,
    completion: @escaping (Result<Void, IngestError>) -> Void
  ) {
    let body = IngestRequestBody(
      helperVersion: helperVersion,
      hostOS: hostOS,
      state: state.wireValue,
      stsAppId: stsAppId,
      activityDetail: activityDetail,
      reportedAt: ISO8601DateFormatter.helper.string(from: reportedAt)
    )

    let url = baseURL.appendingPathComponent("coop/rich-presence/ingest")
    var req = URLRequest(url: url)
    req.httpMethod = "POST"
    req.setValue("application/json", forHTTPHeaderField: "content-type")
    req.setValue("application/json", forHTTPHeaderField: "accept")
    req.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "authorization")
    do {
      req.httpBody = try JSONEncoder().encode(body)
    } catch {
      completion(.failure(.transport(error)))
      return
    }

    let task = urlSession.dataTask(with: req) { _, resp, err in
      if let err = err {
        completion(.failure(.transport(err)))
        return
      }
      guard let http = resp as? HTTPURLResponse else {
        completion(.failure(.malformedResponse))
        return
      }
      if (200..<300).contains(http.statusCode) {
        completion(.success(()))
      } else {
        completion(.failure(.http(http.statusCode)))
      }
    }
    task.resume()
  }
}

extension ISO8601DateFormatter {
  static let helper: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()
}
