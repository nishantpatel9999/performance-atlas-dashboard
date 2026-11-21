"""Command-line entry point for portable performance reports."""

import argparse
import csv
from pathlib import Path

from .build import render_bundle
from .inputs import load_config


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build one self-contained offline performance report.")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--demo", action="store_true", help="generate the deterministic synthetic cross-asset example")
    source.add_argument("--config", type=Path, help="canonical v1 JSON or a manifest with relative CSV paths")
    parser.add_argument("--output", type=Path, required=True, help="destination HTML file")
    args = parser.parse_args(argv)
    try:
        if args.demo:
            from .demo import demo_bundle
            bundle = demo_bundle()
        else:
            bundle = load_config(args.config, output=args.output)
        print(render_bundle(bundle, args.output))
    except (ValueError, OSError, csv.Error) as exc:
        parser.exit(2, f"{parser.prog}: {exc}\n")


if __name__ == "__main__":
    main()
