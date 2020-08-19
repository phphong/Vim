import { Position, PositionDiff, PositionDiffType, sorted } from '../../common/motion/position';
import { configuration } from '../../configuration/configuration';
import { isVisualMode, Mode } from '../../mode/mode';
import { Register, RegisterMode } from '../../register/register';
import { RecordedState } from '../../state/recordedState';
import { VimState } from '../../state/vimState';
import { TextEditor } from '../../textEditor';
import { reportLinesChanged } from '../../util/statusBarTextUtils';
import { BaseCommand, RegisterAction } from '../base';
import * as operator from '../operator';

/**
 * Flags used for executing PutCommand.
 */
export interface IPutCommandOptions {
  /**
   * Determines whether to put the text before or after the cursor position.
   *
   * True for commands like `P` and `gP`
   */
  pasteBeforeCursor?: boolean;

  /**
   * Adjust the indent of the put to match the current line's indentation.
   *
   * True for commands like `]p` and `[p`
   */
  adjustIndent?: boolean;

  /**
   * Forces a linewise register mode put.
   *
   * True only for `:p[ut]`
   */
  forceLinewise?: boolean;

  /**
   * Forces the cursor to move to the last line of what you pasted.
   *
   * True only for `:p[ut]`
   */
  forceCursorLastLine?: boolean;
}

@RegisterAction
export class PutCommand extends BaseCommand {
  keys = ['p'];
  modes = [Mode.Normal];
  runsOnceForEachCountPrefix = true;
  canBeRepeatedWithDot = true;

  constructor(multicursorIndex?: number) {
    super();
    this.multicursorIndex = multicursorIndex;
  }

  public static async getText(
    vimState: VimState,
    multicursorIndex: number | undefined
  ): Promise<string> {
    const register = await Register.get(vimState);

    if (vimState.isMultiCursor) {
      if (multicursorIndex === undefined) {
        throw new Error('No multi-cursor index when calling PutCommand#getText');
      }

      if (typeof register.text === 'object') {
        return register.text[multicursorIndex];
      }
    }

    return register.text as string;
  }

  public async exec(
    position: Position,
    vimState: VimState,
    options: IPutCommandOptions = {}
  ): Promise<VimState> {
    const register = await Register.get(vimState);
    const dest = options.pasteBeforeCursor ? position : position.getRight();
    const registerMode = options.forceLinewise ? RegisterMode.LineWise : register.registerMode;

    if (register.text instanceof RecordedState) {
      /**
       *  Paste content from recordedState. This one is actually complex as
       *  Vim has internal key code for key strokes.For example, Backspace
       *  is stored as `<80>kb`. So if you replay a macro, which is stored
       *  in a register as `a1<80>kb2`, youshall just get `2` inserted as
       *  `a` represents entering Insert Mode, `<80>bk` represents
       *  Backspace. However here, we shall
       *  insert the plain text content of the register, which is `a1<80>kb2`.
       */
      vimState.recordedState.transformations.push({
        type: 'macro',
        register: vimState.recordedState.registerName,
        replay: 'keystrokes',
      });
      return vimState;
    } else if (typeof register.text === 'object' && vimState.currentMode === Mode.VisualBlock) {
      return this.execVisualBlockPaste(
        register.text,
        position,
        vimState,
        options.pasteBeforeCursor || false
      );
    }

    let text = await PutCommand.getText(vimState, this.multicursorIndex);

    const noPrevLine = vimState.cursorStartPosition.line === 0;
    const noNextLine = vimState.cursorStopPosition.line === TextEditor.getLineCount() - 1;

    let textToAdd: string;
    let whereToAddText: Position;
    if (registerMode === RegisterMode.CharacterWise) {
      textToAdd = text;
      whereToAddText = dest;
    } else if (vimState.currentMode === Mode.Visual && registerMode === RegisterMode.LineWise) {
      // in the specific case of linewise register data during visual mode,
      // we need extra newline feeds
      textToAdd = '\n' + text + '\n';
      whereToAddText = dest;
    } else if (vimState.currentMode === Mode.VisualLine && registerMode === RegisterMode.LineWise) {
      // in the specific case of linewise register data during visual mode,
      // we need extra newline feeds
      const left = !noPrevLine && noNextLine ? '\n' : '';
      const right = noNextLine ? '' : '\n';
      textToAdd = left + text + right;
      whereToAddText = dest;
    } else {
      if (options.adjustIndent) {
        // Adjust indent to current line
        let indentationWidth = TextEditor.getIndentationLevel(TextEditor.getLineAt(position).text);
        let firstLineIdentationWidth = TextEditor.getIndentationLevel(text.split('\n')[0]);

        text = text
          .split('\n')
          .map((line) => {
            let currentIdentationWidth = TextEditor.getIndentationLevel(line);
            let newIndentationWidth =
              currentIdentationWidth - firstLineIdentationWidth + indentationWidth;

            return TextEditor.setIndentationLevel(line, newIndentationWidth);
          })
          .join('\n');
      }

      if (registerMode === RegisterMode.LineWise) {
        // P insert before current line
        if (options.pasteBeforeCursor) {
          textToAdd = text + '\n';
          whereToAddText = dest.getLineBegin();
        } else {
          textToAdd = '\n' + text;
          whereToAddText = dest.getLineEnd();
        }
      } else {
        textToAdd = text;
        whereToAddText = options.pasteBeforeCursor ? position : position.getRight();
      }
    }

    // After using "p" or "P" in Visual mode the text that was put will be
    // selected (from Vim's ":help gv").
    if (isVisualMode(vimState.currentMode)) {
      let textToEnd = textToAdd;
      if (vimState.currentMode === Mode.VisualLine && textToAdd[textToAdd.length - 1] === '\n') {
        // don't go next line
        textToEnd = textToAdd.substring(0, textToAdd.length - 1);
      }
      vimState.lastVisualSelection = {
        mode: vimState.currentMode,
        start: whereToAddText,
        end: whereToAddText.advancePositionByText(textToEnd),
      };
    }

    // More vim weirdness: If the thing you're pasting has a newline, the cursor
    // stays in the same place. Otherwise, it moves to the end of what you pasted.

    const numNewlines = text.split('\n').length - 1;
    const currentLineLength = TextEditor.getLineAt(position).text.length;

    let diff: PositionDiff;
    if (vimState.currentMode === Mode.VisualLine) {
      const lines = text.split('\n');
      const whitespaceOnFirstLine = /^\s*/.exec(lines[0])?.[0].length ?? 0;
      let lineDiff = lines.length - 1;
      if (register.registerMode === RegisterMode.LineWise && !noNextLine) {
        lineDiff++;
      }
      diff = {
        type: PositionDiffType.ExactCharacter,
        line: -lineDiff,
        character: whitespaceOnFirstLine,
      };
    } else if (registerMode === RegisterMode.LineWise && options.forceCursorLastLine) {
      // Move to cursor to last line, first non-whitespace character of what you pasted
      let lastLine = text.split('\n')[numNewlines];
      const check = lastLine.match(/^\s*/);
      const numWhitespace = check ? check[0].length : 0;

      let lineDiff: number;
      if (options.pasteBeforeCursor) {
        lineDiff = -numNewlines;
      } else {
        lineDiff = currentLineLength > 0 ? numNewlines + 1 : 0;
      }

      diff = new PositionDiff({
        line: lineDiff,
        character: numWhitespace,
        type: PositionDiffType.ExactCharacter,
      });
    } else if (registerMode === RegisterMode.LineWise) {
      const check = text.match(/^\s*/);
      const numWhitespace = check ? check[0].length : 0;

      if (options.pasteBeforeCursor) {
        diff = new PositionDiff({
          line: -numNewlines - 1,
          character: numWhitespace,
          type: PositionDiffType.ExactCharacter,
        });
      } else {
        diff = new PositionDiff({
          line: currentLineLength > 0 ? 1 : -numNewlines,
          character: numWhitespace,
          type: PositionDiffType.ExactCharacter,
        });
      }
    } else if (!text.includes('\n')) {
      if (!position.isLineEnd()) {
        let characterOffset: number;
        if (registerMode === RegisterMode.BlockWise) {
          characterOffset = options.pasteBeforeCursor ? -text.length : 1;
        } else {
          characterOffset = options.pasteBeforeCursor ? -1 : textToAdd.length;
        }
        diff = new PositionDiff({
          character: characterOffset,
        });
      } else {
        diff = new PositionDiff();
      }
    } else if (position.isLineEnd()) {
      diff = new PositionDiff({
        line: -numNewlines,
        character: position.character,
        type: PositionDiffType.ExactCharacter,
      });
    } else if (options.pasteBeforeCursor) {
      diff = new PositionDiff({
        line: -numNewlines,
        character: position.character,
        type: PositionDiffType.ExactCharacter,
      });
    } else {
      diff = new PositionDiff({
        character: 1,
      });
    }

    vimState.recordedState.transformations.push({
      type: 'insertText',
      text: textToAdd,
      position: whereToAddText,
      diff: diff,
    });
    let numNewlinesAfterPut = textToAdd.split('\n').length;
    if (registerMode === RegisterMode.LineWise) {
      numNewlinesAfterPut--;
    }
    reportLinesChanged(numNewlinesAfterPut, vimState);

    vimState.currentRegisterMode = registerMode;
    return vimState;
  }

  private async execVisualBlockPaste(
    block: string[],
    position: Position,
    vimState: VimState,
    pasteBeforeCursor: boolean
  ): Promise<VimState> {
    if (pasteBeforeCursor) {
      position = position.getRight();
    }

    // Add empty lines at the end of the document, if necessary.
    let linesToAdd = Math.max(0, block.length - (TextEditor.getLineCount() - position.line) + 1);

    if (linesToAdd > 0) {
      await TextEditor.insertAt(
        Array(linesToAdd).join('\n'),
        new Position(
          TextEditor.getLineCount() - 1,
          TextEditor.getLineLength(TextEditor.getLineCount() - 1)
        )
      );
    }

    // paste the entire block.
    for (let lineIndex = position.line; lineIndex < position.line + block.length; lineIndex++) {
      const line = block[lineIndex - position.line];
      const insertPos = new Position(
        lineIndex,
        Math.min(position.character, TextEditor.getLineLength(lineIndex))
      );

      await TextEditor.insertAt(line, insertPos);
    }

    vimState.currentRegisterMode = RegisterMode.AscertainFromCurrentMode;
    return vimState;
  }

  public async execCount(position: Position, vimState: VimState): Promise<VimState> {
    const result = await super.execCount(position, vimState);

    if (
      vimState.effectiveRegisterMode === RegisterMode.LineWise &&
      vimState.recordedState.count > 0
    ) {
      const numNewlines =
        (await PutCommand.getText(vimState, this.multicursorIndex)).split('\n').length *
        vimState.recordedState.count;

      result.recordedState.transformations.push({
        type: 'moveCursor',
        diff: new PositionDiff({ line: -numNewlines + 1 }),
        cursorIndex: this.multicursorIndex,
      });

      reportLinesChanged(numNewlines, vimState);
    }

    return result;
  }
}

@RegisterAction
class PutBeforeCommand extends BaseCommand {
  public keys = ['P'];
  public modes = [Mode.Normal];
  canBeRepeatedWithDot = true;
  runsOnceForEachCountPrefix = true;

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    return new PutCommand(this.multicursorIndex).exec(position, vimState, {
      pasteBeforeCursor: true,
    });
  }
}

@RegisterAction
class PutCommandVisual extends BaseCommand {
  keys = [['p'], ['P']];
  modes = [Mode.Visual, Mode.VisualLine];
  runsOnceForEachCountPrefix = true;

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    let [start, end] = sorted(vimState.cursorStartPosition, vimState.cursorStopPosition);
    if (vimState.currentMode === Mode.VisualLine) {
      [start, end] = [start.getLineBegin(), end.getLineEnd()];
    }

    // If the to-be-inserted text is linewise, we have separate logic:
    // first delete the selection, then insert
    const oldMode = vimState.currentMode;
    let register = await Register.get(vimState);
    if (register.registerMode === RegisterMode.LineWise) {
      const replaceRegisterName = vimState.recordedState.registerName;
      const replaceRegister = await Register.get(vimState, replaceRegisterName);
      vimState.recordedState.registerName = configuration.useSystemClipboard ? '*' : '"';
      await new operator.DeleteOperator(this.multicursorIndex).run(vimState, start, end, true);
      const deletedRegisterName = vimState.recordedState.registerName;
      const deletedRegister = await Register.get(vimState, deletedRegisterName);
      if (replaceRegisterName === deletedRegisterName) {
        Register.putByKey(replaceRegister.text, replaceRegisterName, replaceRegister.registerMode);
      }
      // To ensure that the put command knows this is
      // a linewise register insertion in visual mode of
      // characterwise, linewise
      let resultMode = vimState.currentMode;
      await vimState.setCurrentMode(oldMode);
      vimState.recordedState.registerName = replaceRegisterName;
      await new PutCommand().exec(start, vimState, { pasteBeforeCursor: true });
      await vimState.setCurrentMode(resultMode);
      if (replaceRegisterName === deletedRegisterName) {
        Register.putByKey(deletedRegister.text, deletedRegisterName, deletedRegister.registerMode);
      }
      return vimState;
    }

    // The reason we need to handle Delete and Yank separately is because of
    // linewise mode. If we're in visualLine mode, then we want to copy
    // linewise but not necessarily delete linewise.
    await new PutCommand(this.multicursorIndex).exec(start, vimState, {
      pasteBeforeCursor: true,
    });
    vimState.currentRegisterMode =
      oldMode === Mode.VisualLine ? RegisterMode.LineWise : RegisterMode.CharacterWise;
    vimState.recordedState.registerName = configuration.useSystemClipboard ? '*' : '"';
    await new operator.YankOperator(this.multicursorIndex).run(vimState, start, end);
    vimState.currentRegisterMode = RegisterMode.CharacterWise;
    await new operator.DeleteOperator(this.multicursorIndex).run(
      vimState,
      start,
      end.getLeftIfEOL(),
      false
    );
    vimState.currentRegisterMode = RegisterMode.AscertainFromCurrentMode;
    return vimState;
  }

  // TODO - execWithCount
}

@RegisterAction
class GPutCommand extends BaseCommand {
  keys = ['g', 'p'];
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine];
  runsOnceForEachCountPrefix = true;
  canBeRepeatedWithDot = true;

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    return new PutCommand().exec(position, vimState);
  }

  public async execCount(position: Position, vimState: VimState): Promise<VimState> {
    const register = await Register.get(vimState);
    let addedLinesCount: number;

    if (register.text instanceof RecordedState) {
      vimState.recordedState.transformations.push({
        type: 'macro',
        register: vimState.recordedState.registerName,
        replay: 'keystrokes',
      });

      return vimState;
    }
    if (typeof register.text === 'object') {
      // visual block mode
      addedLinesCount = register.text.length * vimState.recordedState.count;
    } else {
      addedLinesCount = register.text.split('\n').length;
    }

    const result = await super.execCount(position, vimState);

    if (vimState.effectiveRegisterMode === RegisterMode.LineWise) {
      result.recordedState.transformations.push({
        type: 'moveCursor',
        diff: PositionDiff.newBOLDiff(addedLinesCount),
        cursorIndex: this.multicursorIndex,
      });
    }

    return result;
  }
}

@RegisterAction
class GPutBeforeCommand extends BaseCommand {
  keys = ['g', 'P'];
  modes = [Mode.Normal];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    await new PutCommand().exec(position, vimState, { pasteBeforeCursor: true });
    const register = await Register.get(vimState);
    let addedLinesCount: number;

    if (register.text instanceof RecordedState) {
      vimState.recordedState.transformations.push({
        type: 'macro',
        register: vimState.recordedState.registerName,
        replay: 'keystrokes',
      });

      return vimState;
    } else if (typeof register.text === 'object') {
      // visual block mode
      addedLinesCount = register.text.length * vimState.recordedState.count;
    } else {
      addedLinesCount = register.text.split('\n').length;
    }

    if (vimState.effectiveRegisterMode === RegisterMode.LineWise) {
      vimState.recordedState.transformations.push({
        type: 'moveCursor',
        diff: PositionDiff.newBOLDiff(addedLinesCount),
        cursorIndex: this.multicursorIndex,
      });
    }

    return vimState;
  }
}

@RegisterAction
class PutWithIndentCommand extends BaseCommand {
  keys = [']', 'p'];
  modes = [Mode.Normal, Mode.Visual, Mode.VisualLine];
  runsOnceForEachCountPrefix = true;
  canBeRepeatedWithDot = true;

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    return new PutCommand().exec(position, vimState, { adjustIndent: true });
  }
}

@RegisterAction
class PutBeforeWithIndentCommand extends BaseCommand {
  keys = [
    ['[', 'P'],
    [']', 'P'],
    ['[', 'p'],
  ];
  modes = [Mode.Normal];

  public async exec(position: Position, vimState: VimState): Promise<VimState> {
    await new PutCommand().exec(position, vimState, {
      pasteBeforeCursor: true,
      adjustIndent: true,
    });

    if (vimState.effectiveRegisterMode === RegisterMode.LineWise) {
      vimState.cursorStopPosition = TextEditor.getFirstNonWhitespaceCharOnLine(
        vimState.cursorStopPosition.getUp().line
      );
    }

    return vimState;
  }
}
