
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "backend_api"))
from historical_activity import import_archive, load_archive
from activity_outlook import train_archive


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    importer = commands.add_parser("import", help="Replace a regional SQLite archive atomically")
    importer.add_argument("--detections", type=Path, required=True)
    importer.add_argument("--coverage", type=Path, required=True)
    importer.add_argument("--manifest", type=Path, required=True)
    importer.add_argument("--output", type=Path, required=True)
    trainer = commands.add_parser("train", help="Offline chronological model fit and untouched holdout evaluation")
    trainer.add_argument("--archive", type=Path, required=True)
    trainer.add_argument("--output", type=Path, required=True)
    trainer.add_argument("--iterations", type=int, default=150)
    args = parser.parse_args()
    if args.command == "import":
        result = import_archive(args.output, args.detections, args.coverage, json.loads(args.manifest.read_text(encoding="utf-8-sig")))
    else:
        archive = load_archive(args.archive)
        if archive[0] is None:
            parser.error("Archive does not exist; import the regional reporting dataset first.")
        if not 1 <= args.iterations <= 10000:
            parser.error("iterations must be from 1 to 10000.")
        model = train_archive(archive, args.output, args.iterations)
        result = {key: model[key] for key in ("modelVersion", "promoted", "promotionChecks", "evaluation", "partitions")}
    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
