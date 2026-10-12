"""Rebase a verified, stopped tenant's copied OpenCode database, never its source."""
import json
import pathlib
import sqlite3
import stat
import sys


def absolute(value):
    path = pathlib.Path(value)
    if not path.is_absolute() or str(path) != value or value == '/' or '..' in path.parts:
        raise ValueError('invalid migration path')
    return path


def rebase(database, previous, current):
    database = absolute(database)
    previous = str(absolute(previous))
    current = str(absolute(current))
    if previous == current or current.startswith(previous + '/') or previous.startswith(current + '/'):
        raise ValueError('overlapping migration workspaces')
    for path in [database, *database.parents]:
        if stat.S_ISLNK(path.lstat().st_mode):
            raise ValueError('symlinked migration database')
    if not database.is_file() or database.stat().st_nlink != 1:
        raise ValueError('invalid migration database')
    connection = sqlite3.connect('file:' + str(database) + '?mode=rw', uri=True, timeout=5)
    counts = {}
    try:
        if connection.execute('PRAGMA quick_check').fetchone() != ('ok',):
            raise ValueError('invalid copied history')
        with connection:
            for table, column in [('session', 'directory'), ('session', 'path'), ('project', 'worktree')]:
                columns = {row[1] for row in connection.execute('PRAGMA table_info("' + table + '")')}
                if column not in columns:
                    continue
                # Prefix equality avoids LIKE interpreting underscores in user IDs.
                cursor = connection.execute(
                    'UPDATE "' + table + '" SET "' + column + '" = ? || substr("' + column + '", ?) '
                    'WHERE "' + column + '" = ? OR substr("' + column + '", 1, ?) = ?',
                    (current, len(previous) + 1, previous, len(previous) + 1, previous + '/'))
                counts[table + '.' + column] = cursor.rowcount
            foreign = connection.execute(
                'SELECT count(*) FROM session WHERE directory != ? AND substr(directory, 1, ?) != ?',
                (current, len(current) + 1, current + '/')).fetchone()[0]
            if foreign:
                raise ValueError('history contains foreign session directories')
        if connection.execute('PRAGMA quick_check').fetchone() != ('ok',):
            raise ValueError('rebased history integrity failed')
        connection.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        return {'verified': True, 'updated': counts}
    finally:
        connection.close()


if __name__ == '__main__':
    try:
        if len(sys.argv) != 4:
            raise ValueError('database and two workspaces required')
        print(json.dumps(rebase(*sys.argv[1:])))
    except Exception:
        print('Copied tenant history rebasing failed', file=sys.stderr)
        sys.exit(1)
