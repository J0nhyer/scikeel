import {it,expect,vi} from 'vitest';
import {mountEditor} from './monacoSetup';
const state=vi.hoisted(()=>({events:[] as string[],model:{dispose:vi.fn()},editor:{dispose:vi.fn(),getModel:vi.fn(),onDidChangeModelContent:vi.fn()}}));
vi.mock('monaco-editor',()=>({editor:{create:()=>state.editor,defineTheme:vi.fn()}}));
vi.mock('monaco-editor/editor/editor.worker?worker',()=>({default:class{}}));
vi.mock('monaco-editor/language/json/json.worker?worker',()=>({default:class{}}));
vi.mock('monaco-editor/language/typescript/ts.worker?worker',()=>({default:class{}}));
it('detaches the editor and subscriptions before disposing its owned text model',()=>{
 state.editor.getModel.mockReturnValue(state.model);state.model.dispose.mockImplementation(()=>state.events.push('model'));state.editor.dispose.mockImplementation(()=>state.events.push('editor'));state.editor.onDidChangeModelContent.mockReturnValue({dispose:()=>state.events.push('subscription')});
 const editor=mountEditor({parent:document.createElement('div'),doc:'draft',language:'plaintext',readOnly:false,prose:true,ariaLabel:'notes',onChange:vi.fn()});editor.destroy();expect(state.events).toEqual(['subscription','editor','model']);
});
