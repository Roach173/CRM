import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { sheetToObjects, rowsToStudents, STUDENT_REQUIRED } from './ImportExport';

describe('legacy Excel sheets with merged 2-column headers', () => {
  it('splits a merged "Время" header into start+end, and "Препод" into grammar+club teacher', () => {
    const matrix = [
      ['', 'Фамилия Имя Отчество', 'Время', '', 'Число', 'Оплата', 'Уровень', '№', 'Препод', '', 'Книги'],
      [1, 'Зарылбекова Айжан Максатовна', '08:20', '09:40', '15.май', 4300, 'Pre-Intermediate', '№ 7', 'Max', 'William', 'Book'],
    ];
    const ws = XLSX.utils.aoa_to_sheet(matrix);
    const students = rowsToStudents(sheetToObjects(ws, STUDENT_REQUIRED));

    expect(students).toHaveLength(1);
    expect(students[0].time).toBe('08:20-09:40');
    expect(students[0].grammarTeacher).toBe('Max');
    expect(students[0].clubTeacher).toBe('William');
    expect(students[0].cabinet).toBe('7');
  });

  it('leaves a single-cell "HH:MM-HH:MM" time untouched', () => {
    const matrix = [
      ['Имя', 'Email', 'Время'],
      ['Иван', 'ivan@example.com', '09:40-11:00'],
    ];
    const ws = XLSX.utils.aoa_to_sheet(matrix);
    const students = rowsToStudents(sheetToObjects(ws, STUDENT_REQUIRED));

    expect(students[0].time).toBe('09:40-11:00');
  });

  it('does not invent a club teacher when there is no unlabeled column after "Препод"', () => {
    const matrix = [
      ['Имя', 'Email', 'Препод'],
      ['Иван', 'ivan@example.com', 'Max'],
    ];
    const ws = XLSX.utils.aoa_to_sheet(matrix);
    const students = rowsToStudents(sheetToObjects(ws, STUDENT_REQUIRED));

    expect(students[0].grammarTeacher).toBe('Max');
    expect(students[0].clubTeacher).toBeUndefined();
  });
});
