// Stepsemble for macOS.
//
// Opened, the app is the Workspace: the same pages a browser shows, signed in
// to the Host on this Mac. It also gives the Host a stable macOS identity:
// launchd runs it with --serve, and it runs the Node.js Host as its child, so
// macOS attributes file access (Documents, Desktop, external drives) to
// Stepsemble, whichever Node.js is installed or updated. Its Folder Access
// window asks macOS for that access.
import AppKit
import Foundation
import WebKit

let appVersion = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "development"
let fullDiskAccessSettings = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")!

// MARK: - Text

enum Text {
    static let tables: [String: [String: String]] = [
        "en": [
            "closeTab": "Close Tab",
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
            "about": "About Stepsemble",
            "folderAccess": "Folder Access…",
            "hide": "Hide Stepsemble",
            "hideOthers": "Hide Others",
            "showAll": "Show All",
            "file": "File",
            "newWindow": "New Window",
            "closeWindow": "Close Window",
            "edit": "Edit",
            "undo": "Undo",
            "redo": "Redo",
            "cut": "Cut",
            "copy": "Copy",
            "paste": "Paste",
            "selectAll": "Select All",
            "view": "View",
            "reload": "Reload",
            "actualSize": "Actual Size",
            "zoomIn": "Zoom In",
            "zoomOut": "Zoom Out",
            "window": "Window",
            "minimize": "Minimize",
            "zoom": "Zoom",
            "bringAllToFront": "Bring All to Front",
            "waitingHost": "It starts by itself when you log in to this Mac. This window connects as soon as it answers.",
            "retry": "Try Again",
            "ok": "OK",
            "cancel": "Cancel",
        ],
        "zh-Hant": [
            "closeTab": "關閉分頁",
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
            "about": "關於 Stepsemble",
            "folderAccess": "資料夾取用權限…",
            "hide": "隱藏 Stepsemble",
            "hideOthers": "隱藏其他",
            "showAll": "顯示全部",
            "file": "檔案",
            "newWindow": "新增視窗",
            "closeWindow": "關閉視窗",
            "edit": "編輯",
            "undo": "還原",
            "redo": "重做",
            "cut": "剪下",
            "copy": "拷貝",
            "paste": "貼上",
            "selectAll": "全選",
            "view": "顯示方式",
            "reload": "重新載入",
            "actualSize": "實際大小",
            "zoomIn": "放大",
            "zoomOut": "縮小",
            "window": "視窗",
            "minimize": "縮到最小",
            "zoom": "縮放",
            "bringAllToFront": "將此程式所有視窗移至最前",
            "waitingHost": "登入這台 Mac 時它會自動啟動。一有回應，這個視窗就會連上。",
            "retry": "再試一次",
            "ok": "好",
            "cancel": "取消",
        ],
        "zh-Hans": [
            "closeTab": "关闭标签页",
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
            "about": "关于 Stepsemble",
            "folderAccess": "文件夹访问权限…",
            "hide": "隐藏 Stepsemble",
            "hideOthers": "隐藏其他",
            "showAll": "全部显示",
            "file": "文件",
            "newWindow": "新建窗口",
            "closeWindow": "关闭窗口",
            "edit": "编辑",
            "undo": "撤销",
            "redo": "重做",
            "cut": "剪切",
            "copy": "拷贝",
            "paste": "粘贴",
            "selectAll": "全选",
            "view": "显示",
            "reload": "重新载入",
            "actualSize": "实际大小",
            "zoomIn": "放大",
            "zoomOut": "缩小",
            "window": "窗口",
            "minimize": "最小化",
            "zoom": "缩放",
            "bringAllToFront": "前置全部窗口",
            "waitingHost": "登录这台 Mac 时它会自动启动。一有响应，这个窗口就会连接。",
            "retry": "再试一次",
            "ok": "好",
            "cancel": "取消",
        ],
        "ja": [
            "closeTab": "タブを閉じる",
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
            "about": "Stepsemble について",
            "folderAccess": "フォルダへのアクセス…",
            "hide": "Stepsemble を隠す",
            "hideOthers": "ほかを隠す",
            "showAll": "すべてを表示",
            "file": "ファイル",
            "newWindow": "新規ウインドウ",
            "closeWindow": "ウインドウを閉じる",
            "edit": "編集",
            "undo": "取り消す",
            "redo": "やり直す",
            "cut": "カット",
            "copy": "コピー",
            "paste": "ペースト",
            "selectAll": "すべてを選択",
            "view": "表示",
            "reload": "再読み込み",
            "actualSize": "実際のサイズ",
            "zoomIn": "拡大",
            "zoomOut": "縮小",
            "window": "ウインドウ",
            "minimize": "しまう",
            "zoom": "拡大/縮小",
            "bringAllToFront": "すべてを手前に移動",
            "waitingHost": "この Mac にログインすると自動的に起動します。応答があり次第、このウインドウが接続します。",
            "retry": "再試行",
            "ok": "OK",
            "cancel": "キャンセル",
        ],
        "ko": [
            "closeTab": "탭 닫기",
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
            "about": "Stepsemble에 관하여",
            "folderAccess": "폴더 접근…",
            "hide": "Stepsemble 가리기",
            "hideOthers": "기타 가리기",
            "showAll": "모두 보기",
            "file": "파일",
            "newWindow": "새로운 윈도우",
            "closeWindow": "윈도우 닫기",
            "edit": "편집",
            "undo": "실행 취소",
            "redo": "실행 복귀",
            "cut": "오려두기",
            "copy": "복사하기",
            "paste": "붙여넣기",
            "selectAll": "전체 선택",
            "view": "보기",
            "reload": "새로 고침",
            "actualSize": "실제 크기",
            "zoomIn": "확대",
            "zoomOut": "축소",
            "window": "윈도우",
            "minimize": "최소화",
            "zoom": "확대/축소",
            "bringAllToFront": "모두 앞으로 가져오기",
            "waitingHost": "이 Mac에 로그인하면 자동으로 시작됩니다. 응답하는 즉시 이 윈도우가 연결됩니다.",
            "retry": "다시 시도",
            "ok": "확인",
            "cancel": "취소",
        ],
        "tr": [
            "closeTab": "Sekmeyi Kapat",
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
            "about": "Stepsemble Hakkında",
            "folderAccess": "Klasör Erişimi…",
            "hide": "Stepsemble'ı Gizle",
            "hideOthers": "Diğerlerini Gizle",
            "showAll": "Tümünü Göster",
            "file": "Dosya",
            "newWindow": "Yeni Pencere",
            "closeWindow": "Pencereyi Kapat",
            "edit": "Düzen",
            "undo": "Geri Al",
            "redo": "Yinele",
            "cut": "Kes",
            "copy": "Kopyala",
            "paste": "Yapıştır",
            "selectAll": "Tümünü Seç",
            "view": "Görüntü",
            "reload": "Yeniden Yükle",
            "actualSize": "Gerçek Boyut",
            "zoomIn": "Yakınlaştır",
            "zoomOut": "Uzaklaştır",
            "window": "Pencere",
            "minimize": "Küçült",
            "zoom": "Büyüt",
            "bringAllToFront": "Tümünü Öne Getir",
            "waitingHost": "Bu Mac'te oturum açtığınızda kendiliğinden başlar. Yanıt verir vermez bu pencere bağlanır.",
            "retry": "Yeniden Dene",
            "ok": "Tamam",
            "cancel": "Vazgeç",
        ],
        "fr": [
            "closeTab": "Fermer l’onglet",
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
            "about": "À propos de Stepsemble",
            "folderAccess": "Accès aux dossiers…",
            "hide": "Masquer Stepsemble",
            "hideOthers": "Masquer les autres",
            "showAll": "Tout afficher",
            "file": "Fichier",
            "newWindow": "Nouvelle fenêtre",
            "closeWindow": "Fermer la fenêtre",
            "edit": "Édition",
            "undo": "Annuler",
            "redo": "Rétablir",
            "cut": "Couper",
            "copy": "Copier",
            "paste": "Coller",
            "selectAll": "Tout sélectionner",
            "view": "Présentation",
            "reload": "Recharger",
            "actualSize": "Taille réelle",
            "zoomIn": "Zoom avant",
            "zoomOut": "Zoom arrière",
            "window": "Fenêtre",
            "minimize": "Placer dans le Dock",
            "zoom": "Zoom",
            "bringAllToFront": "Tout ramener au premier plan",
            "waitingHost": "Il démarre tout seul quand vous ouvrez une session sur ce Mac. Cette fenêtre s’y connecte dès qu’il répond.",
            "retry": "Réessayer",
            "ok": "OK",
            "cancel": "Annuler",
        ],
        "de": [
            "closeTab": "Tab schließen",
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
            "about": "Über Stepsemble",
            "folderAccess": "Ordnerzugriff …",
            "hide": "Stepsemble ausblenden",
            "hideOthers": "Andere ausblenden",
            "showAll": "Alle einblenden",
            "file": "Ablage",
            "newWindow": "Neues Fenster",
            "closeWindow": "Fenster schließen",
            "edit": "Bearbeiten",
            "undo": "Widerrufen",
            "redo": "Wiederholen",
            "cut": "Ausschneiden",
            "copy": "Kopieren",
            "paste": "Einsetzen",
            "selectAll": "Alles auswählen",
            "view": "Darstellung",
            "reload": "Neu laden",
            "actualSize": "Originalgröße",
            "zoomIn": "Vergrößern",
            "zoomOut": "Verkleinern",
            "window": "Fenster",
            "minimize": "Im Dock ablegen",
            "zoom": "Zoomen",
            "bringAllToFront": "Alle nach vorne bringen",
            "waitingHost": "Es startet von selbst bei der Anmeldung an diesem Mac. Dieses Fenster verbindet sich, sobald es antwortet.",
            "retry": "Erneut versuchen",
            "ok": "OK",
            "cancel": "Abbrechen",
        ],
        "es": [
            "closeTab": "Cerrar pestaña",
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
            "about": "Acerca de Stepsemble",
            "folderAccess": "Acceso a carpetas…",
            "hide": "Ocultar Stepsemble",
            "hideOthers": "Ocultar otros",
            "showAll": "Mostrar todo",
            "file": "Archivo",
            "newWindow": "Nueva ventana",
            "closeWindow": "Cerrar ventana",
            "edit": "Edición",
            "undo": "Deshacer",
            "redo": "Rehacer",
            "cut": "Cortar",
            "copy": "Copiar",
            "paste": "Pegar",
            "selectAll": "Seleccionar todo",
            "view": "Visualización",
            "reload": "Volver a cargar",
            "actualSize": "Tamaño real",
            "zoomIn": "Ampliar",
            "zoomOut": "Reducir",
            "window": "Ventana",
            "minimize": "Minimizar",
            "zoom": "Zoom",
            "bringAllToFront": "Traer todo al frente",
            "waitingHost": "Se inicia solo al iniciar sesión en este Mac. Esta ventana se conecta en cuanto responda.",
            "retry": "Reintentar",
            "ok": "Aceptar",
            "cancel": "Cancelar",
        ],
        "pt-BR": [
            "closeTab": "Fechar aba",
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
            "about": "Sobre o Stepsemble",
            "folderAccess": "Acesso a Pastas…",
            "hide": "Ocultar Stepsemble",
            "hideOthers": "Ocultar Outros",
            "showAll": "Mostrar Tudo",
            "file": "Arquivo",
            "newWindow": "Nova Janela",
            "closeWindow": "Fechar Janela",
            "edit": "Editar",
            "undo": "Desfazer",
            "redo": "Refazer",
            "cut": "Recortar",
            "copy": "Copiar",
            "paste": "Colar",
            "selectAll": "Selecionar Tudo",
            "view": "Visualizar",
            "reload": "Recarregar",
            "actualSize": "Tamanho Real",
            "zoomIn": "Aumentar Zoom",
            "zoomOut": "Diminuir Zoom",
            "window": "Janela",
            "minimize": "Minimizar",
            "zoom": "Zoom",
            "bringAllToFront": "Trazer Tudo para a Frente",
            "waitingHost": "Ele inicia sozinho quando você inicia sessão neste Mac. Esta janela se conecta assim que ele responder.",
            "retry": "Tentar Novamente",
            "ok": "OK",
            "cancel": "Cancelar",
        ],
        "it": [
            "closeTab": "Chiudi scheda",
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
            "about": "Informazioni su Stepsemble",
            "folderAccess": "Accesso alle cartelle…",
            "hide": "Nascondi Stepsemble",
            "hideOthers": "Nascondi altre",
            "showAll": "Mostra tutte",
            "file": "Archivio",
            "newWindow": "Nuova finestra",
            "closeWindow": "Chiudi finestra",
            "edit": "Composizione",
            "undo": "Annulla",
            "redo": "Ripristina",
            "cut": "Taglia",
            "copy": "Copia",
            "paste": "Incolla",
            "selectAll": "Seleziona tutto",
            "view": "Vista",
            "reload": "Ricarica",
            "actualSize": "Dimensioni reali",
            "zoomIn": "Ingrandisci",
            "zoomOut": "Riduci",
            "window": "Finestra",
            "minimize": "Contrai",
            "zoom": "Zoom",
            "bringAllToFront": "Porta tutto in primo piano",
            "waitingHost": "Si avvia da solo quando accedi a questo Mac. Questa finestra si collega appena risponde.",
            "retry": "Riprova",
            "ok": "OK",
            "cancel": "Annulla",
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

// MARK: - Places macOS protects

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
// MARK: - The Host on this Mac

/// What the LaunchAgent that starts the Host says: whether it starts the Host
/// through this app, and the port and token file it gives it.
struct LaunchAgent {
    var startsThroughApp = false
    var port: Int?
    var tokenFile: String?

    static func read() -> LaunchAgent {
        let file = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/com.stepsemble.server.plist")
        guard let data = try? Data(contentsOf: file),
              let plist = (try? PropertyListSerialization.propertyList(from: data, format: nil)) as? [String: Any] else { return LaunchAgent() }
        let arguments = plist["ProgramArguments"] as? [String] ?? []
        let environment = plist["EnvironmentVariables"] as? [String: String] ?? [:]
        return LaunchAgent(
            startsThroughApp: arguments.count > 1 && arguments[0].hasSuffix("/Stepsemble.app/Contents/MacOS/Stepsemble") && arguments[1] == "--serve",
            port: environment["STEPSEMBLE_PORT"].flatMap { Int($0) },
            tokenFile: environment["STEPSEMBLE_TOKEN_FILE"])
    }
}

/// Ports the Host may answer on, the likeliest first.
func hostPorts() -> [Int] {
    var ports: [Int] = []
    let usable: (Int?) -> Int? = { port in port.flatMap { (1024...65535).contains($0) ? $0 : nil } }
    // Started with the Host's own STEPSEMBLE_PORT, the app opens that Host.
    if let port = usable(ProcessInfo.processInfo.environment["STEPSEMBLE_PORT"].flatMap { Int($0) }) { ports.append(port) }
    let device = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".pi/agent/device.json")
    if let data = try? Data(contentsOf: device),
       let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
       let port = usable(json["port"] as? Int), !ports.contains(port) {
        ports.append(port)
    }
    if let port = usable(LaunchAgent.read().port), !ports.contains(port) { ports.append(port) }
    if !ports.contains(3140) { ports.append(3140) }
    return ports
}

func hostURL(_ port: Int, _ path: String = "/") -> URL {
    URL(string: "http://127.0.0.1:\(port)\(path)")!
}

/// The first port the Host answers on, with its version; nil when none does.
func findHost(_ ports: [Int] = hostPorts(), completion: @escaping (Int?, String?) -> Void) {
    guard let port = ports.first else { completion(nil, nil); return }
    var request = URLRequest(url: hostURL(port, "/api/health"))
    request.timeoutInterval = 3
    URLSession.shared.dataTask(with: request) { data, _, _ in
        let json = data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any]
        if (json?["ok"] as? Bool) == true, let version = json?["appVersion"] as? String {
            completion(port, version.hasPrefix("v") ? String(version.dropFirst()) : version)
        } else {
            findHost(Array(ports.dropFirst()), completion: completion)
        }
    }.resume()
}

/// Signs the app's pages in with this Mac's Web token, as the sign-in page
/// would; the token stays out of the pages. The Host marks its cookie Secure
/// for HTTPS gateways, so the app keeps a copy without that flag, which WebKit
/// sends to the Host on this Mac.
func signIn(port: Int, into store: WKHTTPCookieStore, completion: @escaping () -> Void) {
    let path = ProcessInfo.processInfo.environment["STEPSEMBLE_TOKEN_FILE"] ?? LaunchAgent.read().tokenFile
        ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/stepsemble/token").path
    guard let token = (try? String(contentsOfFile: path, encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty,
          let body = try? JSONSerialization.data(withJSONObject: ["token": token]) else { completion(); return }
    var request = URLRequest(url: hostURL(port, "/api/login"))
    request.httpMethod = "POST"
    request.httpBody = body
    request.timeoutInterval = 5
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("http://127.0.0.1:\(port)", forHTTPHeaderField: "Origin")
    let session = URLSession(configuration: .ephemeral)
    session.dataTask(with: request) { _, response, _ in
        var cookies: [HTTPCookie] = []
        if let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
            var headers: [String: String] = [:]
            for (key, value) in http.allHeaderFields { if let key = key as? String, let value = value as? String { headers[key] = value } }
            // Foundation drops Secure cookies read for an http address, so they
            // are read for the same host over https.
            for cookie in HTTPCookie.cookies(withResponseHeaderFields: headers, for: URL(string: "https://127.0.0.1/")!)
            where !cookie.value.isEmpty && (cookie.expiresDate ?? .distantFuture) > Date() {
                var properties = cookie.properties ?? [:]
                properties.removeValue(forKey: .secure)
                if let local = HTTPCookie(properties: properties) { cookies.append(local) }
            }
        }
        session.finishTasksAndInvalidate()
        DispatchQueue.main.async {
            let group = DispatchGroup()
            for cookie in cookies {
                group.enter()
                store.setCookie(cookie) { group.leave() }
            }
            group.notify(queue: .main, execute: completion)
        }
    }.resume()
}

func escapeHTML(_ text: String) -> String {
    text.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: ">", with: "&gt;")
}

// MARK: - Folder access window

final class AccessPanel: NSObject {
    private let showWorkspace: () -> Void
    private var window: NSWindow?
    private let hostLine = NSTextField(labelWithString: "")
    private let help = NSTextField(wrappingLabelWithString: "")
    private var rows: [(place: Place, state: NSTextField)] = []
    private var allowButton: NSButton?
    private var asking = false

    init(showWorkspace: @escaping () -> Void) {
        self.showWorkspace = showWorkspace
    }

    func show(ask: Bool) {
        if window == nil { buildWindow() }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        refreshHost()
        if ask { requestAccess() }
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
        let openWorkspace = NSButton(title: Text.t("openWeb"), target: self, action: #selector(openWorkspace))
        openWorkspace.bezelStyle = .rounded
        let buttons = NSStackView(views: [allow, fullDisk, openWorkspace])
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
        window.title = Text.t("folderAccess").replacingOccurrences(of: "…", with: "").trimmingCharacters(in: .whitespaces)
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
        self.window = window
    }

    private func refreshHost() {
        findHost { _, version in
            DispatchQueue.main.async {
                self.hostLine.stringValue = version.map { Text.t("running", ["version": $0]) } ?? Text.t("notRunning")
            }
        }
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
        showWorkspace()
    }
}

// MARK: - Workspace window

/// The Workspace draws the window's top edge itself, as a browser's tab strip
/// does: the title bar is transparent and untitled, the window's buttons sit
/// over the page, and the page lays itself out around them. A script tells
/// the page where they are; the page names the empty parts of its top edge,
/// and the app moves the window from those.
enum WindowChrome {
    static func script(_ geometry: [String: Any]) -> WKUserScript {
        let json = (try? JSONSerialization.data(withJSONObject: geometry)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
        let source = """
        (() => {
          const root = document.documentElement;
          const apply = chrome => {
            root.dataset.macWindow = chrome.mode;
            for (const name of ["titlebar-height", "controls-start", "controls-end", "controls-center", "controls-bottom"])
              root.style.setProperty("--mac-" + name, (Number(chrome[name]) || 0) + "px");
            dispatchEvent(new Event("stepsemble-mac-window"));
          };
          Object.defineProperty(window, "stepsembleMacWindow", { value: apply });
          apply(\(json));
        })();
        """
        return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }
}

/// What double-clicking a title bar does, as chosen in System Settings.
func titleBarDoubleClicked(_ window: NSWindow) {
    let defaults = UserDefaults.standard
    switch defaults.string(forKey: "AppleActionOnDoubleClick") {
    case "Minimize"?: window.performMiniaturize(nil)
    case "None"?: break
    case nil where defaults.bool(forKey: "AppleMiniaturizeOnDoubleClick"): window.performMiniaturize(nil)
    default: window.performZoom(nil)
    }
}

/// Lies over the page and takes the mouse only on the parts of the page's top
/// edge the page names as empty, where it moves the window as a title bar does.
final class WindowDragArea: NSView {
    /// In the page's CSS pixels, from its top-left corner.
    var regions: [CGRect] = []
    weak var webView: WKWebView?

    override var isFlipped: Bool { true }

    override func hitTest(_ point: NSPoint) -> NSView? {
        guard !regions.isEmpty, let superview = superview else { return nil }
        let local = convert(point, from: superview), zoom = webView?.pageZoom ?? 1
        let inside = regions.contains { CGRect(x: $0.minX * zoom, y: $0.minY * zoom, width: $0.width * zoom, height: $0.height * zoom).contains(local) }
        return inside ? self : nil
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        guard let window = window else { return }
        if event.clickCount == 2 { titleBarDoubleClicked(window) } else { window.performDrag(with: event) }
    }
}

/// One window of the Workspace, the same pages the browser shows, signed in
/// to the Host on this Mac.
final class WorkspaceWindow: NSObject, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    let window: NSWindow
    let webView: WKWebView
    /// Opened by a page (window.open); WebKit loads it.
    let isPopup: Bool
    var visibleSessions: Set<String> = []
    private var pendingNotice: [String: String]?
    private weak var controller: AppController?
    private var port: Int?
    private var path: String
    private var retryTimer: Timer?
    private var titleObservation: NSKeyValueObservation?
    private let dragArea = WindowDragArea()
    /// The page draws the window's top edge (see WindowChrome).
    private var chromeless = false
    private var fullScreen = false

    init(controller: AppController, configuration: WKWebViewConfiguration, path: String, size: NSSize?, isPopup: Bool) {
        self.controller = controller
        self.path = path
        self.isPopup = isPopup
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsBackForwardNavigationGestures = false
        window = NSWindow(contentRect: NSRect(origin: .zero, size: size ?? NSSize(width: 1280, height: 820)),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        window.title = "Stepsemble"
        window.minSize = NSSize(width: 480, height: 400)
        window.isReleasedWhenClosed = false
        // The Workspace has its own tabs; a macOS tab bar would cover them.
        window.tabbingMode = .disallowed
        let content = NSView(frame: NSRect(origin: .zero, size: window.contentRect(forFrameRect: window.frame).size))
        for view in [webView, dragArea] as [NSView] {
            view.frame = content.bounds
            view.autoresizingMask = [.width, .height]
            content.addSubview(view)
        }
        dragArea.webView = webView
        window.contentView = content
        window.initialFirstResponder = webView
        window.delegate = self
        setChromeless(true)
        // A window a page opens shares its opener's scripts.
        if configuration.userContentController.userScripts.isEmpty {
            configuration.userContentController.addUserScript(WindowChrome.script(chromeGeometry()))
        }
        titleObservation = webView.observe(\.title) { [weak self] webView, _ in
            let title = webView.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            self?.window.title = title.isEmpty ? "Stepsemble" : title
        }
    }

    // MARK: Title bar

    /// The Workspace, and the page shown while waiting for the Host, draw the
    /// window's top edge; other pages keep the title bar.
    private func drawsOwnTop(_ url: URL?) -> Bool {
        guard let url = url else { return true }
        return url.scheme == "about" || (isHost(url) && url.path == "/workspace.html")
    }

    private func setChromeless(_ on: Bool) {
        guard on != chromeless else { return }
        chromeless = on
        // Adding or removing the toolbar would otherwise resize the window.
        let frame = window.frame
        if on {
            window.styleMask.insert(.fullSizeContentView)
            // An empty toolbar gives the title bar a browser's height, with
            // the window's buttons centred in it.
            window.toolbar = NSToolbar(identifier: "StepsembleWorkspace")
            window.toolbarStyle = .unified
        } else {
            window.styleMask.remove(.fullSizeContentView)
            window.toolbar = nil
        }
        window.titlebarAppearsTransparent = on
        window.titleVisibility = on ? .hidden : .visible
        window.titlebarSeparatorStyle = on ? .none : .automatic
        window.setFrame(frame, display: true)
        dragArea.regions = []
    }

    /// Where the window's buttons sit, in the page's CSS pixels.
    private func chromeGeometry() -> [String: Any] {
        guard chromeless else { return ["mode": "titled"] }
        guard !fullScreen, let close = window.standardWindowButton(.closeButton),
              let zoom = window.standardWindowButton(.zoomButton) else { return ["mode": "fullscreen"] }
        let scale = max(webView.pageZoom, 0.1), height = window.frame.height
        let closeFrame = close.convert(close.bounds, to: nil), zoomFrame = zoom.convert(zoom.bounds, to: nil)
        return [
            "mode": "chromeless",
            "titlebar-height": (height - window.contentLayoutRect.maxY) / scale,
            "controls-start": closeFrame.minX / scale,
            "controls-end": zoomFrame.maxX / scale,
            "controls-center": (height - closeFrame.midY) / scale,
            "controls-bottom": (height - closeFrame.minY) / scale,
        ]
    }

    private func sendChrome() {
        guard let data = try? JSONSerialization.data(withJSONObject: chromeGeometry()),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.stepsembleMacWindow && window.stepsembleMacWindow(\(json))", completionHandler: nil)
    }

    /// From the page: the empty parts of its top edge, in CSS pixels.
    func setDragRegions(_ rects: [[Double]]) {
        guard chromeless, !fullScreen else { dragArea.regions = []; return }
        dragArea.regions = rects.prefix(32).compactMap { $0.count == 4 ? CGRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]) : nil }
    }

    /// From the page: the theme chosen in Stepsemble, so the window, its
    /// buttons and dialogs match it. "auto" follows macOS.
    func setAppearance(_ theme: String) {
        window.appearance = theme == "dark" ? NSAppearance(named: .darkAqua) : theme == "light" ? NSAppearance(named: .aqua) : nil
    }

    func show(cascadeFrom other: NSWindow?) {
        if let other = other {
            window.setFrameTopLeftPoint(other.cascadeTopLeft(from: NSPoint(x: other.frame.minX, y: other.frame.maxY)))
        } else if !window.setFrameUsingName("StepsembleWorkspace") {
            window.center()
        }
        if other == nil { window.setFrameAutosaveName("StepsembleWorkspace") }
        window.makeKeyAndOrderFront(nil)
        sendChrome()
    }

    // Finds the Host, signs in, and opens the page; waits while the Host is not running.
    func connect() {
        retryTimer?.invalidate()
        retryTimer = nil
        findHost { port, _ in
            DispatchQueue.main.async {
                guard let port = port else { self.showWaiting(); return }
                self.port = port
                signIn(port: port, into: self.webView.configuration.websiteDataStore.httpCookieStore) {
                    self.webView.load(URLRequest(url: hostURL(port, self.path)))
                }
            }
        }
    }

    private func showWaiting() {
        let page = """
        <!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark">
        <style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;font:13px -apple-system,system-ui;background:Canvas;color:CanvasText}
        main{max-width:440px;padding:24px;text-align:center}h1{font-size:17px;font-weight:600;margin:0 0 8px}p{opacity:.7;line-height:1.45}button{font:inherit;padding:5px 16px}</style>
        <main><h1>\(escapeHTML(Text.t("notRunning")))</h1><p>\(escapeHTML(Text.t("waitingHost")))</p>
        <button onclick="webkit.messageHandlers.stepsemble.postMessage('retry')">\(escapeHTML(Text.t("retry")))</button></main>
        """
        webView.loadHTMLString(page, baseURL: nil)
        retryTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            findHost { port, _ in
                guard port != nil else { return }
                DispatchQueue.main.async { if self?.retryTimer != nil { self?.connect() } }
            }
        }
    }

    private func isHost(_ url: URL) -> Bool {
        guard let port = port else { return false }
        return url.scheme == "http" && (url.host == "127.0.0.1" || url.host == "localhost") && url.port == port
    }
    func trusts(_ frame: WKFrameInfo) -> Bool { frame.request.url.map(isHost) == true }
    func openNotice(_ notice: [String: String]) {
        if webView.isLoading { pendingNotice = notice; window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return }
        guard let data = try? JSONSerialization.data(withJSONObject: notice), let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('stepsemble-open-notification',{detail:\(json)}))", completionHandler: nil)
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
    }

    private func openOutside(_ url: URL) {
        if ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(url) }
    }

    // MARK: Menu actions (reached through the responder chain)

    @objc func reloadPage(_ sender: Any?) {
        guard let port = port, webView.url.map(isHost) == true else { connect(); return }
        signIn(port: port, into: webView.configuration.websiteDataStore.httpCookieStore) { self.webView.reload() }
    }

    func closeSessionTab(_ sender: Any?) {
        if isPopup { window.performClose(sender); return }
        guard let url = webView.url, isHost(url), url.path == "/workspace.html" || url.path == "/" else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new Event('stepsemble-close-tab'))", completionHandler: nil)
    }

    private static let zoomSteps: [CGFloat] = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]
    @objc func actualSize(_ sender: Any?) { setZoom(1) }
    @objc func zoomIn(_ sender: Any?) { setZoom(Self.zoomSteps.first { $0 > webView.pageZoom + 0.01 } ?? webView.pageZoom) }
    @objc func zoomOut(_ sender: Any?) { setZoom(Self.zoomSteps.last { $0 < webView.pageZoom - 0.01 } ?? webView.pageZoom) }
    private func setZoom(_ zoom: CGFloat) {
        webView.pageZoom = zoom
        sendChrome()
    }

    // MARK: Window

    // In full screen the window's buttons are hidden; the page uses its own top.
    func windowWillEnterFullScreen(_ notification: Notification) {
        fullScreen = true
        dragArea.regions = []
        sendChrome()
    }

    func windowDidExitFullScreen(_ notification: Notification) {
        fullScreen = false
        sendChrome()
    }

    func windowDidFailToEnterFullScreen(_ window: NSWindow) {
        fullScreen = false
        sendChrome()
    }

    func window(_ window: NSWindow, willUseFullScreenPresentationOptions proposedOptions: NSApplication.PresentationOptions = []) -> NSApplication.PresentationOptions {
        proposedOptions.union(.autoHideToolbar)
    }

    func windowWillClose(_ notification: Notification) {
        retryTimer?.invalidate()
        retryTimer = nil
        titleObservation = nil
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        // Released after AppKit has finished closing the window.
        DispatchQueue.main.async { [weak controller, self] in
            self.window.delegate = nil
            controller?.closed(self)
        }
    }

    // MARK: Navigation

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if #available(macOS 11.3, *), action.shouldPerformDownload { decisionHandler(.download); return }
        guard let url = action.request.url else { decisionHandler(.cancel); return }
        // A file dropped outside a drop zone would replace the Workspace.
        if url.isFileURL { decisionHandler(.cancel); return }
        let scheme = url.scheme?.lowercased() ?? ""
        let otherSite = port != nil && !isHost(url) && ["http", "https", "mailto"].contains(scheme)
        // Another site opens in the default browser rather than replacing the
        // Workspace or one of its panes: a link in any frame, or any page the
        // main frame or a new window would load.
        if otherSite && (action.navigationType == .linkActivated || action.targetFrame?.isMainFrame != false) {
            openOutside(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if #available(macOS 11.3, *), !response.canShowMIMEType { decisionHandler(.download); return }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        // A page that draws the top names its own empty parts once laid out.
        setChromeless(drawsOwnTop(webView.url))
        sendChrome()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        sendChrome()
        if let notice = pendingNotice { pendingNotice = nil; openNotice(notice) }
        // The waiting page moves the window from its top, as a title bar would.
        if chromeless, webView.url?.scheme == "about" {
            let height = (chromeGeometry()["titlebar-height"] as? CGFloat) ?? 0
            dragArea.regions = [CGRect(x: 0, y: 0, width: 100_000, height: height)]
        }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if isPopup { webView.reload() } else { connect() }
    }

    // MARK: Pages asking for windows, dialogs and files

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = action.request.url, let controller = controller else { return nil }
        if isHost(url) {
            let size = NSSize(width: windowFeatures.width?.doubleValue ?? 1100, height: windowFeatures.height?.doubleValue ?? 820)
            return controller.openPopup(configuration: configuration, size: size, port: port, from: window).webView
        }
        openOutside(url)
        return nil
    }

    func setPort(_ port: Int?) { self.port = port }

    func webViewDidClose(_ webView: WKWebView) {
        window.close()
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: Text.t("ok"))
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: Text.t("ok"))
        alert.addButton(withTitle: Text.t("cancel"))
        alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(string: defaultText ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 280, height: 24)
        alert.accessoryView = field
        alert.addButton(withTitle: Text.t("ok"))
        alert.addButton(withTitle: Text.t("cancel"))
        alert.window.initialFirstResponder = field
        alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { response in completionHandler(response == .OK ? panel.urls : nil) }
    }
}

// MARK: Downloads

/// Downloads go to Downloads, without replacing a file already there.
func downloadDestination(_ suggested: String) -> URL? {
    guard let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first else { return nil }
    let name = (suggested as NSString).lastPathComponent.trimmingCharacters(in: .whitespacesAndNewlines)
    let base = name.isEmpty || name.hasPrefix(".") ? "Download" + name : name
    let stem = (base as NSString).deletingPathExtension, ext = (base as NSString).pathExtension
    var candidate = folder.appendingPathComponent(base)
    var number = 2
    while FileManager.default.fileExists(atPath: candidate.path) {
        candidate = folder.appendingPathComponent(ext.isEmpty ? "\(stem) \(number)" : "\(stem) \(number).\(ext)")
        number += 1
    }
    return candidate
}

@available(macOS 11.3, *)
extension WorkspaceWindow: WKDownloadDelegate {
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        completionHandler(downloadDestination(suggestedFilename))
    }
}

// MARK: - App

/// Receives the pages' messages without the content controller keeping the
/// app controller alive.
final class MessageRelay: NSObject, WKScriptMessageHandler {
    weak var controller: AppController?
    init(_ controller: AppController) { self.controller = controller }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        controller?.received(message)
    }
}

final class AppController: NSObject, NSApplicationDelegate {
    private var askForAccess: Bool
    private var launched = false
    private var windows: [WorkspaceWindow] = []
    private let processPool = WKProcessPool()
    private lazy var relay = MessageRelay(self)
    private lazy var access = AccessPanel(showWorkspace: { [weak self] in self?.showWorkspace() })
    private lazy var notifications = NativeNotifications(open: { [weak self] notice in self?.openNotice(notice) }, visible: { [weak self] host, key in
        NSApp.isActive && self?.windows.contains(where: { $0.window.isVisible && $0.window.occlusionState.contains(.visible) && $0.visibleSessions.contains("\(host):\(key)") }) == true
    })
    /// Folder access matters only when this app starts the Host.
    private let startsHost = LaunchAgent.read().startsThroughApp

    init(askForAccess: Bool) {
        self.askForAccess = askForAccess
    }

    func applicationWillFinishLaunching(_ notification: Notification) {
        NSAppleEventManager.shared().setEventHandler(self, andSelector: #selector(openURL(_:reply:)),
                                                     forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        newWindow(path: "/workspace.html")
        NSApp.activate(ignoringOtherApps: true)
        launched = true
        notifications.start()
        // The first time, the app asks for the places macOS protects.
        let shownKey = "folderAccessShown"
        if startsHost && (askForAccess || !UserDefaults.standard.bool(forKey: shownKey)) {
            UserDefaults.standard.set(true, forKey: shownKey)
            access.show(ask: askForAccess)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showWorkspace() }
        return true
    }

    /// stepsemble://folder-access, sent by the Host when a folder is refused.
    @objc func openURL(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        guard let text = event.paramDescriptor(forKeyword: keyDirectObject)?.stringValue,
              let url = URL(string: text), url.scheme == "stepsemble", url.host == "folder-access" else { return }
        if launched { access.show(ask: true) } else { askForAccess = true }
    }

    private func configuration() -> WKWebViewConfiguration {
        let configuration = WKWebViewConfiguration()
        configuration.processPool = processPool
        configuration.websiteDataStore = .default()
        configuration.applicationNameForUserAgent = "Stepsemble/\(appVersion)"
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = true
        configuration.userContentController.add(relay, name: "stepsemble")
        return configuration
    }

    func newWindow(path: String) {
        let previous = windows.last?.window
        let workspace = WorkspaceWindow(controller: self, configuration: configuration(), path: path, size: nil, isPopup: false)
        windows.append(workspace)
        workspace.show(cascadeFrom: previous)
        workspace.connect()
    }

    func openPopup(configuration: WKWebViewConfiguration, size: NSSize, port: Int?, from opener: NSWindow) -> WorkspaceWindow {
        let popup = WorkspaceWindow(controller: self, configuration: configuration, path: "/", size: size, isPopup: true)
        popup.setPort(port)
        windows.append(popup)
        popup.show(cascadeFrom: opener)
        return popup
    }

    func closed(_ workspace: WorkspaceWindow) {
        windows.removeAll { $0 === workspace }
    }

    func showWorkspace() {
        if let workspace = windows.first(where: { !$0.isPopup }) ?? windows.first {
            workspace.window.makeKeyAndOrderFront(nil)
        } else {
            newWindow(path: "/workspace.html")
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    func received(_ message: WKScriptMessage) {
        guard let workspace = windows.first(where: { $0.webView === message.webView }) else { return }
        if message.body as? String == "retry" { workspace.connect(); return }
        if workspace.trusts(message.frameInfo), let body = message.body as? [String: Any] {
            if message.frameInfo.isMainFrame && body["type"] as? String == "notification-presence" {
                workspace.visibleSessions = Set((body["sessions"] as? [[String: String]] ?? []).prefix(8).compactMap { row in
                    guard let host = row["host"], let key = row["key"], UUID(uuidString: key) != nil else { return nil }
                    return "\(host):\(key)"
                })
            }
            if body["type"] as? String == "notifications", let request = body["requestId"] as? String, !request.isEmpty, request.count <= 128,
               let host = body["host"] as? String, host.range(of: "^[a-zA-Z0-9_-]{1,128}$", options: .regularExpression) != nil, let action = body["action"] as? String,
               ["status", "enable", "disable", "settings", "test"].contains(action) {
                notifications.request(action, host: host, locale: body["locale"] as? String ?? "en") { result in
                    let reply: [String: Any] = ["type": "stepsemble-native-notifications", "requestId": request, "result": result]
                    guard let data = try? JSONSerialization.data(withJSONObject: reply), let json = String(data: data, encoding: .utf8) else { return }
                    workspace.webView.evaluateJavaScript("window.postMessage(\(json),location.origin);document.querySelectorAll('iframe').forEach(f=>f.contentWindow.postMessage(\(json),location.origin))", completionHandler: nil)
                }
            }
        }
        if message.frameInfo.isMainFrame, let body = message.body as? [String: Any], body["type"] as? String == "drag-regions" {
            workspace.setDragRegions(body["rects"] as? [[Double]] ?? [])
        }
        if message.frameInfo.isMainFrame, let body = message.body as? [String: Any], body["type"] as? String == "appearance" {
            workspace.setAppearance(body["theme"] as? String ?? "auto")
        }
    }

    @objc func newWorkspaceWindow(_ sender: Any?) {
        // Its own layout, as the Workspace's own "new window" opens.
        newWindow(path: "/workspace.html?window=\(UUID().uuidString.lowercased())")
    }

    @objc func closeSessionTab(_ sender: Any?) {
        if let workspace = windows.first(where: { $0.window === NSApp.keyWindow }) { workspace.closeSessionTab(sender) }
        else { NSApp.keyWindow?.performClose(sender) }
    }
    private func openNotice(_ notice: [String: String]) {
        guard notice["key"] != "test", let host = notice["host"], let key = notice["key"], UUID(uuidString: key) != nil else { showWorkspace(); return }
        if let workspace = windows.first(where: { !$0.isPopup && $0.webView.url?.path == "/workspace.html" }) { workspace.openNotice(notice) }
        else {
            var url = URLComponents(); url.path = "/workspace.html"; url.queryItems = [URLQueryItem(name: "host", value: host), URLQueryItem(name: "entry", value: key)]
            newWindow(path: url.string ?? "/workspace.html"); NSApp.activate(ignoringOtherApps: true)
        }
    }

    @objc func showFolderAccess(_ sender: Any?) {
        access.show(ask: false)
    }

    private func buildMenu() {
        func item(_ title: String, _ action: Selector?, _ key: String = "", _ modifiers: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
            item.keyEquivalentModifierMask = modifiers
            item.target = target
            return item
        }
        func menu(_ title: String, _ items: [NSMenuItem]) -> NSMenuItem {
            let holder = NSMenuItem()
            let menu = NSMenu(title: title)
            items.forEach(menu.addItem)
            holder.submenu = menu
            return holder
        }
        let main = NSMenu()
        var appItems = [item(Text.t("about"), #selector(NSApplication.orderFrontStandardAboutPanel(_:)), target: NSApp), .separator()]
        if startsHost { appItems += [item(Text.t("folderAccess"), #selector(showFolderAccess(_:)), target: self), .separator()] }
        appItems += [
            item(Text.t("hide"), #selector(NSApplication.hide(_:)), "h", target: NSApp),
            item(Text.t("hideOthers"), #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option], target: NSApp),
            item(Text.t("showAll"), #selector(NSApplication.unhideAllApplications(_:)), target: NSApp),
            .separator(),
            item(Text.t("quit"), #selector(NSApplication.terminate(_:)), "q", target: NSApp),
        ]
        main.addItem(menu("Stepsemble", appItems))
        main.addItem(menu(Text.t("file"), [
            item(Text.t("newWindow"), #selector(newWorkspaceWindow(_:)), "n", target: self),
            item(Text.t("closeTab"), #selector(closeSessionTab(_:)), "w", target: self),
            item(Text.t("closeWindow"), #selector(NSWindow.performClose(_:)), "w", [.command, .shift]),
        ]))
        main.addItem(menu(Text.t("edit"), [
            item(Text.t("undo"), Selector(("undo:")), "z"),
            item(Text.t("redo"), Selector(("redo:")), "z", [.command, .shift]),
            .separator(),
            item(Text.t("cut"), #selector(NSText.cut(_:)), "x"),
            item(Text.t("copy"), #selector(NSText.copy(_:)), "c"),
            item(Text.t("paste"), #selector(NSText.paste(_:)), "v"),
            item(Text.t("selectAll"), #selector(NSText.selectAll(_:)), "a"),
        ]))
        main.addItem(menu(Text.t("view"), [
            item(Text.t("reload"), #selector(WorkspaceWindow.reloadPage(_:)), "r"),
            .separator(),
            item(Text.t("actualSize"), #selector(WorkspaceWindow.actualSize(_:)), "0"),
            item(Text.t("zoomIn"), #selector(WorkspaceWindow.zoomIn(_:)), "="),
            item(Text.t("zoomOut"), #selector(WorkspaceWindow.zoomOut(_:)), "-"),
        ]))
        let windowMenu = menu(Text.t("window"), [
            item(Text.t("minimize"), #selector(NSWindow.performMiniaturize(_:)), "m"),
            item(Text.t("zoom"), #selector(NSWindow.performZoom(_:))),
            .separator(),
            item(Text.t("bringAllToFront"), #selector(NSApplication.arrangeInFront(_:)), target: NSApp),
        ])
        main.addItem(windowMenu)
        NSApp.mainMenu = main
        NSApp.windowsMenu = windowMenu.submenu
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
let controller = AppController(askForAccess: arguments.contains("--request-access"))
app.delegate = controller
app.setActivationPolicy(.regular)
app.run()
