import {render,waitFor} from '@testing-library/react';
import {it,expect,vi} from 'vitest';
import {FileEditor} from './FileEditor';
const editor=vi.hoisted(()=>({mount:vi.fn(),destroy:vi.fn(),relabel:vi.fn(),setValue:vi.fn(),retheme:vi.fn()}));
vi.mock('./monacoSetup',()=>({monacoLanguage:()=> 'plaintext',mountEditor:(...args:unknown[])=>{editor.mount(...args);return editor;}}));
it('read-only state changes update the existing editor without losing its caret or undo history',async()=>{
 const {rerender,unmount}=render(<FileEditor value='draft' ariaLabel='notes.md' readOnly={false}/>);await waitFor(()=>expect(editor.mount).toHaveBeenCalledOnce());
 rerender(<FileEditor value='draft' ariaLabel='notes.md' readOnly/>);await waitFor(()=>expect(editor.relabel).toHaveBeenLastCalledWith('notes.md',true));expect(editor.mount).toHaveBeenCalledOnce();expect(editor.destroy).not.toHaveBeenCalled();unmount();expect(editor.destroy).toHaveBeenCalledOnce();
});
