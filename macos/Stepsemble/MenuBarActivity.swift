import Foundation

/// Native polling keeps the status item alive when a closed popover's WebKit
/// process suspends JavaScript/fetch. Only authenticated loopback routes are read.
final class MenuBarActivityReader: NSObject, URLSessionTaskDelegate {
    struct Sample {
        var rate: Double?
        var estimated = false
        var burn: Double?
        var active = 0.0
        var motionRate: Double { max(rate ?? 0, (burn ?? 0) / 1000, active > 0 ? 4 : 0) }
    }
    private var tasks: [URLSessionDataTask] = []
    private var generation = 0
    private var busy = false
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 6
        config.timeoutIntervalForResource = 7
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()
    static func summarize(_ results: [[String: Any]?]) -> Sample {
        var rate = 0.0, active = 0.0, burn = 0.0, measured = 0, historyHosts = 0, estimated = false
        for result in results {
            guard let result = result else { continue }
            let reading = result["live"] as? [String: Any]
            let value = reading?["tokensPerSecond"] as? Double ?? 0
            let live = value.isFinite ? max(0, value) : 0
            let count = reading?["active"] as? Double ?? 0
            if count.isFinite { active += max(0, count) }
            if let history = result["history"] as? [String: Any], history["available"] as? Bool == true,
               let output = history["tokensPerSecond"] as? Double, output.isFinite, output >= 0,
               (result["historyAgeMs"] as? Double ?? 0) < 45000 {
                rate += max(live, output); measured += 1; historyHosts += 1
                estimated = estimated || output >= live || reading?["estimated"] as? Bool == true
                let amount = history["tokensPerMinute"] as? Double ?? 0
                if amount.isFinite && amount >= 0 { burn += amount }
            } else if live > 0 || count > 0 {
                rate += live; measured += 1
                estimated = estimated || reading?["estimated"] as? Bool == true
            }
        }
        return Sample(rate: measured > 0 ? rate : nil, estimated: estimated,
                      burn: historyHosts > 0 ? burn : nil, active: active)
    }

    func poll(port: Int, hosts: [String], cookie: String, completion: @escaping ([[String: Any]?]) -> Void) {
        guard !busy, !hosts.isEmpty else { return }
        busy = true; let epoch = generation
        var values = Array<[String: Any]?>(repeating: nil, count: hosts.count), remaining = hosts.count
        tasks = hosts.enumerated().map { index, host in
            let route = (host.isEmpty ? "" : "/r/\(host)") + "/api/workspace/activity"
            var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)\(route)")!)
            request.setValue(cookie, forHTTPHeaderField: "Cookie")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            let task = session.dataTask(with: request) { [weak self] data, response, _ in
                var value: [String: Any]?
                if let response = response as? HTTPURLResponse, response.statusCode == 200,
                   let data = data, data.count <= 1024 * 1024 {
                    value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                }
                DispatchQueue.main.async {
                    guard let self = self, self.generation == epoch else { return }
                    values[index] = value; remaining -= 1
                    if remaining == 0 { self.busy = false; self.tasks = []; completion(values) }
                }
            }
            return task
        }
        tasks.forEach { $0.resume() }
    }
    func cancel() { generation += 1; tasks.forEach { $0.cancel() }; tasks = []; busy = false }
    func stop() { cancel(); session.invalidateAndCancel() }
    // Do not forward the local authentication cookie through any redirect.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}
