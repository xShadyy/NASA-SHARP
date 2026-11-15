
import argparse
import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src" / "backend_api"))
from global_store import GlobalStore
from global_ingestion import configured_sources, parse_bulk, refresh_global
from datetime import UTC, datetime, timedelta


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["refresh", "status", "import"])
    parser.add_argument("--database", type=Path)
    parser.add_argument("--csv", type=Path)
    parser.add_argument("--source", choices=configured_sources())
    parser.add_argument("--start", help="Explicit reporting-extraction start UTC for import")
    parser.add_argument("--end", help="Explicit exclusive reporting-extraction end UTC for import")
    parser.add_argument("--window", choices=["24h", "7d"], default="24h", help="Shared refresh extract; seven days requires this explicit option")
    args = parser.parse_args()
    store = GlobalStore(args.database)
    if args.command == "refresh":
        result = asyncio.run(refresh_global(store, force=False, window=args.window))
        manifest = result.get("manifest", {})
        print(json.dumps({"state": result["state"], "snapshot": manifest.get("snapshot"), "anchorUtc": manifest.get("anchorUtc"), "status": manifest.get("status"), "sources": manifest.get("sources", []), "metrics": store.metrics()}, indent=2))
    elif args.command == "import":
        if not all((args.csv, args.source, args.start, args.end)):
            parser.error("import requires --csv --source --start --end; do not infer reporting coverage from records")
        start = datetime.fromisoformat(args.start.replace("Z", "+00:00"))
        end = datetime.fromisoformat(args.end.replace("Z", "+00:00"))
        if start.tzinfo is None or end.tzinfo is None or start >= end or end - start > timedelta(days=8):
            parser.error("Import needs offset-aware UTC boundaries and at most eight days")
        text = args.csv.read_text(encoding="utf-8-sig")
        store.replace_source(args.source, parse_bulk(text, args.source), start, end, metadata={"provider": "Explicit administrator CSV import", "processingTier": "NRT"})
        print(json.dumps(store.publish(end.astimezone(UTC), [args.source]), indent=2))
    else:
        print(json.dumps({"manifest": store.current_manifest(), "metrics": store.metrics()}, indent=2))


if __name__ == "__main__":
    main()
