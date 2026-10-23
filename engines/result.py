"""Shared result type for MedFlow batch engines (UC1 → UC2 → UC3)."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class StageResult:
    """Outcome of one use-case engine run for the orchestrator / audit log."""

    name: str
    runid: str
    status: str  # success | failed
    input_rows: int = 0
    output_rows: int = 0
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.status == "success"
