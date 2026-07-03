# REVLIS

REVLIS — редактор и визуализатор синхронизированных TTML-текстов. Репозиторий содержит две версии приложения.

## Структура

- `Sources/`, `Tests/`, `Package.swift` — нативное приложение для macOS на SwiftUI.
- `web/` — автономная браузерная версия для GitHub Pages.
- `.github/workflows/pages.yml` — автоматическая публикация сайта.

## macOS

Требования: Apple Silicon, macOS 13 или новее и установленный Xcode.

```bash
swift run
```

Сборка готового приложения:

```bash
./build-apple-silicon.sh
```

Результат: `.build/apple-silicon/REVLIS.app`.

## Веб-версия

Сайт не отправляет аудио, обложки или TTML на сервер: обработка выполняется локально в браузере.

Для локального запуска:

```bash
cd web
python3 -m http.server 8080
```

Откройте `http://localhost:8080`.

## GitHub Pages

1. Создайте репозиторий на GitHub и загрузите этот проект в ветку `main`.
2. Откройте `Settings → Pages`.
3. В разделе `Build and deployment` выберите `GitHub Actions`.
4. Workflow автоматически опубликует содержимое папки `web/`.

После публикации адрес будет выглядеть так: `https://USERNAME.github.io/REPOSITORY/`.

Для автоматической подготовки и отправки репозитория:

```bash
./publish-to-github.sh https://github.com/USERNAME/REPOSITORY.git
```

## Возможности веб-версии

- импорт и проверка TTML;
- построчная и пословная синхронизация удержанием пробела;
- Apple Music-подобное превью;
- экспорт готового TTML;
- Track Visualizer с Canvas-анимацией;
- браузерный экспорт видео в MP4 или WebM;
- адаптивная светлая и тёмная темы.

Apple-гайд: https://help.apple.com/itc/videoaudioassetguide/?lang=en#/itcd7579a252
