"""Google Sheets CRUD using the signed-in device's OAuth tokens."""

from __future__ import annotations

from contextvars import ContextVar
from dataclasses import dataclass

from googleapiclient.discovery import build
from psycopg_pool import ConnectionPool

from google_auth import credentials_from_connection, creds_expiry, refresh_credentials
from google_store import get_connection, update_tokens

_NOT_CONNECTED = {
    "error": "google_not_connected",
    "message": "Google is not connected. Ask the user to connect with Google first.",
}


@dataclass
class SheetContext:
    device_id: str
    spreadsheet_id: str | None
    gid: str | None
    pool: ConnectionPool


_sheet_context: ContextVar[SheetContext | None] = ContextVar(
    "sheet_context",
    default=None,
)


def set_sheet_context(
    *,
    device_id: str,
    spreadsheet_id: str | None,
    gid: str | None,
    pool: ConnectionPool,
) -> None:
    _sheet_context.set(
        SheetContext(
            device_id=device_id,
            spreadsheet_id=spreadsheet_id,
            gid=gid,
            pool=pool,
        )
    )


def clear_sheet_context() -> None:
    _sheet_context.set(None)


def current_sheet_context() -> SheetContext | None:
    return _sheet_context.get()


def _require_context() -> SheetContext | dict:
    ctx = _sheet_context.get()
    if ctx is None:
        return _NOT_CONNECTED
    return ctx


def _spreadsheet_service():
    ctx = _sheet_context.get()
    if ctx is None:
        return None, _NOT_CONNECTED

    with ctx.pool.connection() as conn:
        row = get_connection(conn, ctx.device_id)
        if row is None:
            return None, _NOT_CONNECTED
        creds = credentials_from_connection(row)
        creds = refresh_credentials(creds)
        if creds.token != row.token:
            update_tokens(
                conn,
                device_id=ctx.device_id,
                token=creds.token,
                token_expiry=creds_expiry(creds),
                refresh_token=creds.refresh_token,
            )
        spreadsheet_id = ctx.spreadsheet_id or row.spreadsheet_id

    if not spreadsheet_id:
        return None, {
            "error": "no_spreadsheet",
            "message": "No spreadsheet is linked. Ask the user to paste a Google Sheet link.",
        }

    service = build("sheets", "v4", credentials=creds, cache_discovery=False)
    return (service, spreadsheet_id), None


def list_tabs_for_device(
    *,
    pool: ConnectionPool,
    device_id: str,
    spreadsheet_id: str | None,
) -> dict:
    with pool.connection() as conn:
        row = get_connection(conn, device_id)
        if row is None:
            return _NOT_CONNECTED
        creds = credentials_from_connection(row)
        creds = refresh_credentials(creds)
        if creds.token != row.token:
            update_tokens(
                conn,
                device_id=device_id,
                token=creds.token,
                token_expiry=creds_expiry(creds),
                refresh_token=creds.refresh_token,
            )
        linked_id = spreadsheet_id or row.spreadsheet_id

    if not linked_id:
        return {
            "error": "no_spreadsheet",
            "message": "No spreadsheet is linked. Ask the user to paste a Google Sheet link.",
        }

    try:
        service = build("sheets", "v4", credentials=creds, cache_discovery=False)
        meta = (
            service.spreadsheets()
            .get(
                spreadsheetId=linked_id,
                fields="properties.title,sheets.properties(sheetId,title)",
            )
            .execute()
        )
    except Exception as exc:
        return {"error": "sheets_list_failed", "message": str(exc)}

    tabs = []
    for sheet in meta.get("sheets") or []:
        props = sheet.get("properties") or {}
        sheet_id = props.get("sheetId")
        title = props.get("title")
        if sheet_id is None or not title:
            continue
        tabs.append({"gid": str(sheet_id), "title": str(title)})

    return {
        "spreadsheet_id": linked_id,
        "spreadsheet_title": (meta.get("properties") or {}).get("title"),
        "tabs": tabs,
    }


def resolve_sheet_meta(service, spreadsheet_id: str, gid: str | None) -> tuple[int, str]:
    meta = (
        service.spreadsheets()
        .get(
            spreadsheetId=spreadsheet_id,
            fields="sheets.properties(sheetId,title)",
        )
        .execute()
    )
    sheets = meta.get("sheets") or []
    if not sheets:
        raise RuntimeError("This spreadsheet has no tabs.")

    if gid:
        for sheet in sheets:
            props = sheet.get("properties") or {}
            if str(props.get("sheetId")) == str(gid):
                return int(props["sheetId"]), str(props["title"])

    props = sheets[0]["properties"]
    return int(props["sheetId"]), str(props["title"])


def resolve_sheet_title(service, spreadsheet_id: str, gid: str | None) -> str:
    _sheet_id, title = resolve_sheet_meta(service, spreadsheet_id, gid)
    return title


def read_sheet() -> dict:
    ctx_or_err = _require_context()
    if isinstance(ctx_or_err, dict):
        return ctx_or_err

    loaded, err = _spreadsheet_service()
    if err:
        return err
    service, spreadsheet_id = loaded
    assert service is not None

    try:
        title = resolve_sheet_title(service, spreadsheet_id, ctx_or_err.gid)
        values = (
            service.spreadsheets()
            .values()
            .get(spreadsheetId=spreadsheet_id, range=title)
            .execute()
            .get("values", [])
        )
    except Exception as exc:
        return {"error": "sheets_read_failed", "message": str(exc)}

    if not values:
        return {
            "spreadsheet_id": spreadsheet_id,
            "sheet": title,
            "headers": [],
            "rows": [],
        }

    headers = [str(h) for h in values[0]]
    rows = []
    for index, raw_row in enumerate(values[1:], start=2):
        record = {
            headers[i]: (str(raw_row[i]) if i < len(raw_row) else "")
            for i in range(len(headers))
        }
        record["_row"] = index
        rows.append(record)

    return {
        "spreadsheet_id": spreadsheet_id,
        "sheet": title,
        "headers": headers,
        "rows": rows,
    }


def append_row(values: list[str]) -> dict:
    ctx_or_err = _require_context()
    if isinstance(ctx_or_err, dict):
        return ctx_or_err

    loaded, err = _spreadsheet_service()
    if err:
        return err
    service, spreadsheet_id = loaded
    assert service is not None

    try:
        title = resolve_sheet_title(service, spreadsheet_id, ctx_or_err.gid)
        result = (
            service.spreadsheets()
            .values()
            .append(
                spreadsheetId=spreadsheet_id,
                range=title,
                valueInputOption="RAW",
                body={"values": [values]},
            )
            .execute()
        )
    except Exception as exc:
        return {"error": "sheets_append_failed", "message": str(exc)}

    return {
        "updated_range": result.get("updates", {}).get("updatedRange"),
        "updated_rows": result.get("updates", {}).get("updatedRows"),
        "values": values,
        "sheet": title,
    }


def update_row(a1_range: str, values: list[str]) -> dict:
    ctx_or_err = _require_context()
    if isinstance(ctx_or_err, dict):
        return ctx_or_err

    loaded, err = _spreadsheet_service()
    if err:
        return err
    service, spreadsheet_id = loaded
    assert service is not None

    range_name = a1_range.strip()
    if "!" not in range_name:
        try:
            title = resolve_sheet_title(service, spreadsheet_id, ctx_or_err.gid)
        except Exception as exc:
            return {"error": "sheets_update_failed", "message": str(exc)}
        range_name = f"{title}!{range_name}"

    try:
        result = (
            service.spreadsheets()
            .values()
            .update(
                spreadsheetId=spreadsheet_id,
                range=range_name,
                valueInputOption="RAW",
                body={"values": [values]},
            )
            .execute()
        )
    except Exception as exc:
        return {"error": "sheets_update_failed", "message": str(exc)}

    return {
        "updated_range": result.get("updatedRange"),
        "updated_rows": result.get("updatedRows"),
        "values": values,
    }


def delete_row(row_number: int) -> dict:
    ctx_or_err = _require_context()
    if isinstance(ctx_or_err, dict):
        return ctx_or_err

    loaded, err = _spreadsheet_service()
    if err:
        return err
    service, spreadsheet_id = loaded
    assert service is not None

    try:
        row_index = int(row_number)
    except (TypeError, ValueError):
        return {
            "error": "sheets_delete_failed",
            "message": "row_number must be a 1-based sheet row, e.g. 4.",
        }

    if row_index < 2:
        return {
            "error": "sheets_delete_failed",
            "message": "Refusing to delete the header row. Use a data row number from _row.",
        }

    try:
        sheet_id, title = resolve_sheet_meta(
            service, spreadsheet_id, ctx_or_err.gid
        )
        service.spreadsheets().batchUpdate(
            spreadsheetId=spreadsheet_id,
            body={
                "requests": [
                    {
                        "deleteDimension": {
                            "range": {
                                "sheetId": sheet_id,
                                "dimension": "ROWS",
                                "startIndex": row_index - 1,
                                "endIndex": row_index,
                            }
                        }
                    }
                ]
            },
        ).execute()
    except Exception as exc:
        return {"error": "sheets_delete_failed", "message": str(exc)}

    return {
        "deleted_row": row_index,
        "sheet": title,
        "spreadsheet_id": spreadsheet_id,
    }
