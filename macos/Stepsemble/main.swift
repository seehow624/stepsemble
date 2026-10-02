// Stepsemble for macOS.
//
// The web workspace stays the interface. This app gives the Host a stable
// macOS identity: launchd runs it with --serve, and it runs the Node.js Host
// as its child, so macOS attributes file access (Documents, Desktop, external
// drives) to Stepsemble, whichever Node.js is installed or updated. Opened
// normally, it shows a small window that asks macOS for that access.
import AppKit
import Foundation

let appVersion = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "development"
let fullDiskAccessSettings = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!

// MARK: - Text

enum Text {
    static let tables: [String: [String: String]] = [
        "en": [
            "quit": "Quit Stepsemble",
            "running": "Stepsemble {version} is running on this Mac.",
            "notRunning": "Stepsemble is not running on this Mac right now.",
            "intro": "macOS asks once whether Stepsemble may use each place below. Projects there open only after you choose Allow.",
            "documents": "Documents",
            "desktop": "Desktop",
            "downloads": "Downloads",
            "icloud": "iCloud Drive",
            "notAsked": "Not asked yet",
            "asking": "Waiting for your answer…",
            "allowed": "Allowed",
            "denied": "Not allowed",
            "unavailable": "Unavailable",
            "allow": "Allow access",
            "fullDisk": "Full Disk Access…",
            "openWeb": "Open Stepsemble",
            "deniedHelp": "To allow a place you turned down, open Full Disk Access and turn on Stepsemble, or allow it under Privacy & Security → Files and Folders.",
            "fullDiskOpened": "Stepsemble is selected in Finder. Drag it into the Full Disk Access list and turn it on.",
            "closeNote": "You can close this window; Stepsemble keeps running.",
        ],
        "zh-Hant": [
            "quit": "結束 Stepsemble",
            "running": "Stepsemble {version} 正在這台 Mac 上運行。",
            "notRunning": "Stepsemble 目前沒有在這台 Mac 上運行。",
            "intro": "macOS 會針對下列每個位置詢問一次，是否允許 Stepsemble 使用。按「允許」之後，才能開啟放在那裡的專案。",
            "documents": "文件",
            "desktop": "桌面",
            "downloads": "下載項目",
            "icloud": "iCloud 雲碟",
            "notAsked": "尚未詢問",
            "asking": "等待你回應…",
            "allowed": "已允許",
            "denied": "未允許",
            "unavailable": "無法使用",
            "allow": "允許取用",
            "fullDisk": "完整磁碟取用權限…",
            "openWeb": "打開 Stepsemble",
            "deniedHelp": "要重新允許曾經拒絕的位置，請打開「完整磁碟取用權限」並開啟 Stepsemble，或到「隱私權與安全性 → 檔案與檔案夾」允許。",
            "fullDiskOpened": "Finder 已選好 Stepsemble。把它拖進「完整磁碟取用權限」清單並打開開關。",
            "closeNote": "可以關閉這個視窗，Stepsemble 會繼續運行。",
        ],
        "zh-Hans": [
            "quit": "退出 Stepsemble",
            "running": "Stepsemble {version} 正在这台 Mac 上运行。",
            "notRunning": "Stepsemble 目前没有在这台 Mac 上运行。",
            "intro": "macOS 会针对下列每个位置询问一次，是否允许 Stepsemble 使用。点按“允许”之后，才能打开放在那里的项目。",
            "documents": "文稿",
            "desktop": "桌面",
            "downloads": "下载",
            "icloud": "iCloud 云盘",
            "notAsked": "尚未询问",
            "asking": "等待你的回应…",
            "allowed": "已允许",
            "denied": "未允许",
            "unavailable": "不可用",
            "allow": "允许访问",
            "fullDisk": "完全磁盘访问权限…",
            "openWeb": "打开 Stepsemble",
            "deniedHelp": "要重新允许曾被拒绝的位置，请打开“完全磁盘访问权限”并开启 Stepsemble，或在“隐私与安全性 → 文件和文件夹”中允许。",
            "fullDiskOpened": "访达已选中 Stepsemble。把它拖到“完全磁盘访问权限”列表并打开开关。",
            "closeNote": "可以关闭这个窗口，Stepsemble 会继续运行。",
        ],
        "ja": [
            "quit": "Stepsemble を終了",
            "running": "Stepsemble {version} はこの Mac で動作しています。",
            "notRunning": "Stepsemble は現在この Mac で動作していません。",
            "intro": "macOS は下の各場所について、Stepsemble が使ってよいかを一度だけ確認します。「許可」を選ぶと、その場所のプロジェクトを開けるようになります。",
            "documents": "書類",
            "desktop": "デスクトップ",
            "downloads": "ダウンロード",
            "icloud": "iCloud Drive",
            "notAsked": "未確認",
            "asking": "応答を待っています…",
            "allowed": "許可済み",
            "denied": "許可されていません",
            "unavailable": "利用できません",
            "allow": "アクセスを許可",
            "fullDisk": "フルディスクアクセス…",
            "openWeb": "Stepsemble を開く",
            "deniedHelp": "拒否した場所を許可するには、フルディスクアクセスを開いて Stepsemble をオンにするか、「プライバシーとセキュリティ → ファイルとフォルダ」で許可してください。",
            "fullDiskOpened": "Finder で Stepsemble を選択しました。フルディスクアクセスの一覧にドラッグしてオンにしてください。",
            "closeNote": "このウインドウは閉じてかまいません。Stepsemble は動作し続けます。",
        ],
        "ko": [
            "quit": "Stepsemble 종료",
            "running": "Stepsemble {version}이(가) 이 Mac에서 실행 중입니다.",
            "notRunning": "Stepsemble이 지금 이 Mac에서 실행되고 있지 않습니다.",
            "intro": "macOS는 아래 각 위치에 대해 Stepsemble의 사용을 허용할지 한 번 묻습니다. '허용'을 선택해야 그곳의 프로젝트를 열 수 있습니다.",
            "documents": "문서",
            "desktop": "데스크탑",
            "downloads": "다운로드",
            "icloud": "iCloud Drive",
            "notAsked": "아직 묻지 않음",
            "asking": "응답을 기다리는 중…",
            "allowed": "허용됨",
            "denied": "허용되지 않음",
            "unavailable": "사용할 수 없음",
            "allow": "접근 허용",
            "fullDisk": "전체 디스크 접근 권한…",
            "openWeb": "Stepsemble 열기",
            "deniedHelp": "거부했던 위치를 허용하려면 전체 디스크 접근 권한을 열어 Stepsemble을 켜거나 '개인정보 보호 및 보안 → 파일 및 폴더'에서 허용하세요.",
            "fullDiskOpened": "Finder에서 Stepsemble이 선택되었습니다. 전체 디스크 접근 권한 목록으로 끌어다 놓고 켜세요.",
            "closeNote": "이 창을 닫아도 Stepsemble은 계속 실행됩니다.",
        ],
        "tr": [
            "quit": "Stepsemble'dan çık",
            "running": "Stepsemble {version} bu Mac'te çalışıyor.",
            "notRunning": "Stepsemble şu anda bu Mac'te çalışmıyor.",
            "intro": "macOS, aşağıdaki her konum için Stepsemble'ın kullanmasına izin verilip verilmeyeceğini bir kez sorar. Oradaki projeler ancak İzin Ver'i seçtikten sonra açılır.",
            "documents": "Belgeler",
            "desktop": "Masaüstü",
            "downloads": "İndirilenler",
            "icloud": "iCloud Drive",
            "notAsked": "Henüz sorulmadı",
            "asking": "Yanıtınız bekleniyor…",
            "allowed": "İzin verildi",
            "denied": "İzin verilmedi",
            "unavailable": "Kullanılamıyor",
            "allow": "Erişime izin ver",
            "fullDisk": "Tam Disk Erişimi…",
            "openWeb": "Stepsemble'ı aç",
            "deniedHelp": "Reddettiğiniz bir konuma izin vermek için Tam Disk Erişimi'ni açıp Stepsemble'ı etkinleştirin ya da Gizlilik ve Güvenlik → Dosyalar ve Klasörler bölümünden izin verin.",
            "fullDiskOpened": "Stepsemble Finder'da seçildi. Onu Tam Disk Erişimi listesine sürükleyip açın.",
            "closeNote": "Bu pencereyi kapatabilirsiniz; Stepsemble çalışmaya devam eder.",
        ],
        "fr": [
            "quit": "Quitter Stepsemble",
            "running": "Stepsemble {version} fonctionne sur ce Mac.",
            "notRunning": "Stepsemble ne fonctionne pas sur ce Mac pour le moment.",
            "intro": "macOS demande une fois, pour chaque emplacement ci-dessous, si Stepsemble peut l’utiliser. Les projets qui s’y trouvent ne s’ouvrent qu’après avoir choisi Autoriser.",
            "documents": "Documents",
            "desktop": "Bureau",
            "downloads": "Téléchargements",
            "icloud": "iCloud Drive",
            "notAsked": "Pas encore demandé",
            "asking": "En attente de votre réponse…",
            "allowed": "Autorisé",
            "denied": "Non autorisé",
            "unavailable": "Indisponible",
            "allow": "Autoriser l’accès",
            "fullDisk": "Accès complet au disque…",
            "openWeb": "Ouvrir Stepsemble",
            "deniedHelp": "Pour autoriser un emplacement refusé, ouvrez Accès complet au disque et activez Stepsemble, ou autorisez-le dans Confidentialité et sécurité → Fichiers et dossiers.",
            "fullDiskOpened": "Stepsemble est sélectionné dans le Finder. Faites-le glisser dans la liste Accès complet au disque et activez-le.",
            "closeNote": "Vous pouvez fermer cette fenêtre ; Stepsemble continue de fonctionner.",
        ],
        "de": [
            "quit": "Stepsemble beenden",
            "running": "Stepsemble {version} läuft auf diesem Mac.",
            "notRunning": "Stepsemble läuft gerade nicht auf diesem Mac.",
            "intro": "macOS fragt für jeden Ort unten einmal, ob Stepsemble ihn verwenden darf. Projekte dort lassen sich erst nach „Erlauben“ öffnen.",
            "documents": "Dokumente",
            "desktop": "Schreibtisch",
            "downloads": "Downloads",
            "icloud": "iCloud Drive",
            "notAsked": "Noch nicht gefragt",
            "asking": "Wartet auf Antwort …",
            "allowed": "Erlaubt",
            "denied": "Nicht erlaubt",
            "unavailable": "Nicht verfügbar",
            "allow": "Zugriff erlauben",
            "fullDisk": "Festplattenvollzugriff …",
            "openWeb": "Stepsemble öffnen",
            "deniedHelp": "Um einen abgelehnten Ort zu erlauben, Festplattenvollzugriff öffnen und Stepsemble einschalten oder ihn unter Datenschutz & Sicherheit → Dateien und Ordner erlauben.",
            "fullDiskOpened": "Stepsemble ist im Finder ausgewählt. Es in die Liste „Festplattenvollzugriff“ ziehen und einschalten.",
            "closeNote": "Dieses Fenster kann geschlossen werden; Stepsemble läuft weiter.",
        ],
        "es": [
            "quit": "Salir de Stepsemble",
            "running": "Stepsemble {version} se está ejecutando en este Mac.",
            "notRunning": "Stepsemble no se está ejecutando en este Mac ahora.",
            "intro": "macOS pregunta una vez, para cada lugar de abajo, si Stepsemble puede usarlo. Los proyectos que hay allí solo se abren después de elegir Permitir.",
            "documents": "Documentos",
            "desktop": "Escritorio",
            "downloads": "Descargas",
            "icloud": "iCloud Drive",
            "notAsked": "Aún no se ha preguntado",
            "asking": "Esperando tu respuesta…",
            "allowed": "Permitido",
            "denied": "No permitido",
            "unavailable": "No disponible",
            "allow": "Permitir acceso",
            "fullDisk": "Acceso total al disco…",
            "openWeb": "Abrir Stepsemble",
            "deniedHelp": "Para permitir un lugar que rechazaste, abre Acceso total al disco y activa Stepsemble, o permítelo en Privacidad y seguridad → Archivos y carpetas.",
            "fullDiskOpened": "Stepsemble está seleccionado en el Finder. Arrástralo a la lista de Acceso total al disco y actívalo.",
            "closeNote": "Puedes cerrar esta ventana; Stepsemble sigue en ejecución.",
        ],
        "pt-BR": [
            "quit": "Encerrar o Stepsemble",
            "running": "O Stepsemble {version} está em execução neste Mac.",
            "notRunning": "O Stepsemble não está em execução neste Mac agora.",
            "intro": "O macOS pergunta uma vez, para cada local abaixo, se o Stepsemble pode usá-lo. Os projetos ali só abrem depois que você escolhe Permitir.",
            "documents": "Documentos",
            "desktop": "Mesa",
            "downloads": "Downloads",
            "icloud": "iCloud Drive",
            "notAsked": "Ainda não perguntado",
            "asking": "Aguardando sua resposta…",
            "allowed": "Permitido",
            "denied": "Não permitido",
            "unavailable": "Indisponível",
            "allow": "Permitir acesso",
            "fullDisk": "Acesso Total ao Disco…",
            "openWeb": "Abrir o Stepsemble",
            "deniedHelp": "Para permitir um local que você recusou, abra Acesso Total ao Disco e ative o Stepsemble, ou permita-o em Privacidade e Segurança → Arquivos e Pastas.",
            "fullDiskOpened": "O Stepsemble está selecionado no Finder. Arraste-o para a lista de Acesso Total ao Disco e ative-o.",
            "closeNote": "Você pode fechar esta janela; o Stepsemble continua em execução.",
        ],
        "it": [
            "quit": "Esci da Stepsemble",
            "running": "Stepsemble {version} è in esecuzione su questo Mac.",
            "notRunning": "Stepsemble non è in esecuzione su questo Mac al momento.",
            "intro": "macOS chiede una volta, per ogni posizione qui sotto, se Stepsemble può usarla. I progetti che si trovano lì si aprono solo dopo aver scelto Consenti.",
            "documents": "Documenti",
            "desktop": "Scrivania",
            "downloads": "Download",
            "icloud": "iCloud Drive",
            "notAsked": "Non ancora richiesto",
            "asking": "In attesa della tua risposta…",
            "allowed": "Consentito",
            "denied": "Non consentito",
            "unavailable": "Non disponibile",
            "allow": "Consenti accesso",
            "fullDisk": "Accesso completo al disco…",
            "openWeb": "Apri Stepsemble",
            "deniedHelp": "Per consentire una posizione rifiutata, apri Accesso completo al disco e attiva Stepsemble, oppure consentila in Privacy e sicurezza → File e cartelle.",
            "fullDiskOpened": "Stepsemble è selezionato nel Finder. Trascinalo nell’elenco Accesso completo al disco e attivalo.",
            "closeNote": "Puoi chiudere questa finestra; Stepsemble continua a funzionare.",
        ],
    ]

    static let language: String = {
        for raw in Locale.preferredLanguages {
            let key = raw.lowercased()
            if key.hasPrefix("zh-hant") || key.hasPrefix("zh-tw") || key.hasPrefix("zh-hk") || key.hasPrefix("zh-mo") { return "zh-Hant" }
            if key.hasPrefix("zh") { return "zh-Hans" }
            if key.hasPrefix("pt") { return "pt-BR" }
            let base = String(key.prefix { $0 != "-" && $0 != "_" })
            if tables[base] != nil { return base }
        }
        return "en"
    }()

    static func t(_ key: String, _ values: [String: String] = [:]) -> String {
        var text = tables[language]?[key] ?? tables["en"]?[key] ?? key
        for (name, value) in values { text = text.replacingOccurrences(of: "{\(name)}", with: value) }
        return text
    }
}

// MARK: - Host supervisor (launchd)

func fail(_ message: String, code: Int32) -> Never {
    FileHandle.standardError.write(Data("Stepsemble: \(message)\n".utf8))
    exit(code)
}

/// Kept for the life of the process so stop signals keep reaching the Host.
var signalSources: [DispatchSourceSignal] = []

/// The exit status a shell would report for a child's wait status.
func exitCode(_ status: Int32) -> Int32 {
    let signalled = status & 0x7f
    return signalled == 0 ? (status >> 8) & 0xff : 128 + signalled
}

/// Runs the Host as a child and stays its parent: macOS asks about, and
/// remembers, file access for this app rather than for the child. Stop
/// signals go to the child; the app exits with the child's status, so launchd
/// restarts both as it restarted the Host before.
func serve(_ command: [String]) -> Never {
    guard let executable = command.first, executable.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: executable) else {
        fail("--serve needs the absolute path of an executable", code: 64)
    }
    var environment = ProcessInfo.processInfo.environment
    environment["STEPSEMBLE_APP_BUNDLE"] = Bundle.main.bundlePath
    environment["STEPSEMBLE_APP_VERSION"] = appVersion
    // posix_spawn keeps the Host in this process group, as it was when launchd
    // ran it directly: whatever it leaves behind ends with the launchd job.
    let argv: [UnsafeMutablePointer<CChar>?] = command.map { strdup($0) } + [nil]
    let envp: [UnsafeMutablePointer<CChar>?] = environment.map { strdup("\($0.key)=\($0.value)") } + [nil]
    var pid: pid_t = 0
    let spawned = posix_spawn(&pid, executable, nil, nil, argv, envp)
    guard spawned == 0 else { fail("could not start \(executable): \(String(cString: strerror(spawned)))", code: 71) }
    // Handlers are set after the child starts, so it keeps the default
    // dispositions for these signals.
    for signalNumber in [SIGTERM, SIGINT, SIGHUP] {
        signal(signalNumber, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: signalNumber, queue: .main)
        source.setEventHandler { kill(pid, signalNumber) }
        source.resume()
        signalSources.append(source)
    }
    Thread.detachNewThread {
        var status: Int32 = 0
        while waitpid(pid, &status, 0) == -1 {
            if errno != EINTR { exit(70) }
        }
        exit(exitCode(status))
    }
    dispatchMain()
}

// MARK: - Folder access window

enum Access {
    case notAsked, asking, allowed, denied, unavailable

    var label: String {
        switch self {
        case .notAsked: return Text.t("notAsked")
        case .asking: return Text.t("asking")
        case .allowed: return Text.t("allowed")
        case .denied: return Text.t("denied")
        case .unavailable: return Text.t("unavailable")
        }
    }
}

struct Place {
    let name: String
    let url: URL
}

/// Time Machine backup disks: macOS keeps them to itself, and no project
/// lives there, so they are not listed.
func timeMachineMountPoints() -> Set<String> {
    let tmutil = Process()
    tmutil.executableURL = URL(fileURLWithPath: "/usr/bin/tmutil")
    tmutil.arguments = ["destinationinfo", "-X"]
    let output = Pipe()
    tmutil.standardOutput = output
    tmutil.standardError = FileHandle.nullDevice
    do { try tmutil.run() } catch { return [] }
    let data = output.fileHandleForReading.readDataToEndOfFile()
    tmutil.waitUntilExit()
    guard let info = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any],
          let destinations = info["Destinations"] as? [[String: Any]] else { return [] }
    return Set(destinations.compactMap { $0["MountPoint"] as? String })
}

/// The places macOS protects: the three folders, iCloud Drive, and every
/// mounted drive other than the startup disk and Time Machine backups.
func protectedPlaces() -> [Place] {
    let files = FileManager.default, home = files.homeDirectoryForCurrentUser
    var places = [
        Place(name: Text.t("documents"), url: home.appendingPathComponent("Documents")),
        Place(name: Text.t("desktop"), url: home.appendingPathComponent("Desktop")),
        Place(name: Text.t("downloads"), url: home.appendingPathComponent("Downloads")),
    ]
    let iCloud = home.appendingPathComponent("Library/Mobile Documents/com~apple~CloudDocs")
    if files.fileExists(atPath: iCloud.path) { places.append(Place(name: Text.t("icloud"), url: iCloud)) }
    let keys: [URLResourceKey] = [.volumeIsRootFileSystemKey, .volumeLocalizedNameKey]
    let backups = timeMachineMountPoints()
    for volume in files.mountedVolumeURLs(includingResourceValuesForKeys: keys, options: [.skipHiddenVolumes]) ?? [] {
        let values = try? volume.resourceValues(forKeys: Set(keys))
        if values?.volumeIsRootFileSystem == true || backups.contains(volume.standardizedFileURL.path) { continue }
        places.append(Place(name: values?.volumeLocalizedName ?? volume.lastPathComponent, url: volume))
    }
    return places
}

/// Reading a protected folder is what makes macOS ask. The read waits while
/// the question is on screen.
func readAccess(_ url: URL) -> Access {
    do {
        _ = try FileManager.default.contentsOfDirectory(atPath: url.path)
        return .allowed
    } catch let error as NSError {
        let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError
        if error.code == NSFileReadNoPermissionError || underlying?.code == Int(EPERM) || underlying?.code == Int(EACCES) { return .denied }
        return .unavailable
    }
}

func hostPort() -> Int {
    let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".pi/agent/device.json")
    if let data = try? Data(contentsOf: file),
       let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
       let port = json["port"] as? Int, (1024...65535).contains(port) {
        return port
    }
    return 3140
}

final class AccessWindow: NSObject, NSApplicationDelegate {
    private let askOnOpen: Bool
    private var window: NSWindow?
    private let hostLine = NSTextField(labelWithString: "")
    private let help = NSTextField(wrappingLabelWithString: "")
    private var rows: [(place: Place, state: NSTextField)] = []
    private var allowButton: NSButton?
    private var asking = false

    init(askOnOpen: Bool) {
        self.askOnOpen = askOnOpen
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        NSApp.activate(ignoringOtherApps: true)
        refreshHost()
        if askOnOpen { requestAccess() }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    private func buildMenu() {
        let main = NSMenu(), appItem = NSMenuItem(), appMenu = NSMenu()
        appMenu.addItem(withTitle: Text.t("quit"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)
        NSApp.mainMenu = main
    }

    private func label(_ text: String, size: CGFloat = 13, weight: NSFont.Weight = .regular, secondary: Bool = false) -> NSTextField {
        let field = NSTextField(wrappingLabelWithString: text)
        field.font = .systemFont(ofSize: size, weight: weight)
        if secondary { field.textColor = .secondaryLabelColor }
        return field
    }

    private func buildWindow() {
        let icon = NSImageView(image: NSApp.applicationIconImage)
        icon.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([icon.widthAnchor.constraint(equalToConstant: 56), icon.heightAnchor.constraint(equalToConstant: 56)])
        hostLine.font = .systemFont(ofSize: 12)
        hostLine.textColor = .secondaryLabelColor
        let titles = NSStackView(views: [label("Stepsemble", size: 20, weight: .semibold), hostLine])
        titles.orientation = .vertical
        titles.alignment = .leading
        titles.spacing = 2
        let header = NSStackView(views: [icon, titles])
        header.spacing = 12

        let list = NSStackView()
        list.orientation = .vertical
        list.alignment = .leading
        list.spacing = 6
        for place in protectedPlaces() {
            let name = NSTextField(labelWithString: place.name)
            name.translatesAutoresizingMaskIntoConstraints = false
            name.widthAnchor.constraint(equalToConstant: 190).isActive = true
            name.lineBreakMode = .byTruncatingTail
            let state = NSTextField(labelWithString: Access.notAsked.label)
            state.textColor = .secondaryLabelColor
            list.addArrangedSubview(NSStackView(views: [name, state]))
            rows.append((place, state))
        }

        let allow = NSButton(title: Text.t("allow"), target: self, action: #selector(requestAccess))
        allow.bezelStyle = .rounded
        allow.keyEquivalent = "\r"
        allowButton = allow
        let fullDisk = NSButton(title: Text.t("fullDisk"), target: self, action: #selector(openFullDiskAccess))
        fullDisk.bezelStyle = .rounded
        let openWeb = NSButton(title: Text.t("openWeb"), target: self, action: #selector(openWorkspace))
        openWeb.bezelStyle = .rounded
        let buttons = NSStackView(views: [allow, fullDisk, openWeb])
        buttons.spacing = 8

        help.font = .systemFont(ofSize: 12)
        help.textColor = .secondaryLabelColor
        help.isHidden = true

        let content = NSStackView(views: [header, label(Text.t("intro")), list, buttons, help, label(Text.t("closeNote"), size: 12, secondary: true)])
        content.orientation = .vertical
        content.alignment = .leading
        content.spacing = 14
        content.edgeInsets = NSEdgeInsets(top: 22, left: 24, bottom: 22, right: 24)
        content.translatesAutoresizingMaskIntoConstraints = false
        for view in content.arrangedSubviews where view is NSTextField {
            view.widthAnchor.constraint(lessThanOrEqualToConstant: 440).isActive = true
        }

        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 488, height: 420), styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Stepsemble"
        window.isReleasedWhenClosed = false
        let container = NSView()
        container.addSubview(content)
        NSLayoutConstraint.activate([
            content.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            content.topAnchor.constraint(equalTo: container.topAnchor),
            content.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            content.widthAnchor.constraint(equalToConstant: 488),
        ])
        window.contentView = container
        window.center()
        window.makeKeyAndOrderFront(nil)
        self.window = window
    }

    private func refreshHost() {
        hostLine.stringValue = ""
        guard let url = URL(string: "http://127.0.0.1:\(hostPort())/api/health") else { return }
        var request = URLRequest(url: url)
        request.timeoutInterval = 3
        URLSession.shared.dataTask(with: request) { data, _, _ in
            let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
            let version = (json?["appVersion"] as? String).map { $0.hasPrefix("v") ? String($0.dropFirst()) : $0 }
            DispatchQueue.main.async {
                self.hostLine.stringValue = version.map { Text.t("running", ["version": $0]) } ?? Text.t("notRunning")
            }
        }.resume()
    }

    /// One place at a time: macOS shows one question at a time anyway.
    @objc func requestAccess() {
        guard !asking else { return }
        asking = true
        allowButton?.isEnabled = false
        let rows = self.rows
        DispatchQueue.global(qos: .userInitiated).async {
            var anyDenied = false
            for row in rows {
                DispatchQueue.main.async { row.state.stringValue = Access.asking.label }
                let result = readAccess(row.place.url)
                if result == .denied { anyDenied = true }
                DispatchQueue.main.async {
                    row.state.stringValue = result.label
                    row.state.textColor = result == .allowed ? .systemGreen : result == .denied ? .systemRed : .secondaryLabelColor
                }
            }
            DispatchQueue.main.async {
                self.asking = false
                self.allowButton?.isEnabled = true
                if anyDenied {
                    self.help.stringValue = Text.t("deniedHelp")
                    self.help.isHidden = false
                }
            }
        }
    }

    @objc func openFullDiskAccess() {
        NSWorkspace.shared.open(fullDiskAccessSettings)
        NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
        help.stringValue = Text.t("fullDiskOpened")
        help.isHidden = false
    }

    @objc func openWorkspace() {
        if let url = URL(string: "http://127.0.0.1:\(hostPort())/") { NSWorkspace.shared.open(url) }
    }
}

// MARK: - Entry

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.first == "--serve" { serve(Array(arguments.dropFirst())) }
if arguments.first == "--version" {
    print(appVersion)
    exit(0)
}
let app = NSApplication.shared
let controller = AccessWindow(askOnOpen: arguments.contains("--request-access"))
app.delegate = controller
app.setActivationPolicy(.regular)
app.run()
