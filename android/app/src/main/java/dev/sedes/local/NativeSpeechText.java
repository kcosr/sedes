package dev.sedes.local;

import java.util.Arrays;
import org.commonmark.ext.footnotes.FootnoteDefinition;
import org.commonmark.ext.footnotes.FootnoteReference;
import org.commonmark.ext.footnotes.FootnotesExtension;
import org.commonmark.ext.gfm.strikethrough.StrikethroughExtension;
import org.commonmark.ext.gfm.tables.TableCell;
import org.commonmark.ext.gfm.tables.TableRow;
import org.commonmark.ext.gfm.tables.TablesExtension;
import org.commonmark.ext.task.list.items.TaskListItemMarker;
import org.commonmark.ext.task.list.items.TaskListItemsExtension;
import org.commonmark.node.*;
import org.commonmark.parser.Parser;

/** Device-owned speech presentation. Never alters a notification or the stored transcript. */
final class NativeSpeechText {
    private static final Parser PARSER = Parser.builder()
        .extensions(Arrays.asList(StrikethroughExtension.create(), TablesExtension.create(), TaskListItemsExtension.create(), FootnotesExtension.create()))
        .maxOpenBlockParsers(100).maxInlineNesting(100).build();

    static String prepare(String markdown, boolean cleanup) {
        if (!cleanup || markdown.isEmpty()) return markdown;
        SpeechWriter writer = new SpeechWriter();
        render(PARSER.parse(markdown), writer);
        return writer.text.toString();
    }

    private static void render(Node node, SpeechWriter writer) {
        if (node instanceof Text) writer.append(((Text) node).getLiteral());
        else if (node instanceof Code) writer.append(((Code) node).getLiteral());
        else if (node instanceof FencedCodeBlock) writer.append(((FencedCodeBlock) node).getLiteral());
        else if (node instanceof IndentedCodeBlock) writer.append(((IndentedCodeBlock) node).getLiteral());
        // Embedded HTML is literal source, just like code; do not discard its contents.
        else if (node instanceof HtmlInline) writer.append(((HtmlInline) node).getLiteral());
        else if (node instanceof HtmlBlock) writer.append(((HtmlBlock) node).getLiteral());
        else if (node instanceof SoftLineBreak) writer.separate(1);
        else if (node instanceof HardLineBreak) writer.separate(2);
        else if (node instanceof FootnoteReference) writer.append(" (footnote " + writer.footnote(((FootnoteReference) node).getLabel()) + ")");
        else if (node instanceof TaskListItemMarker) writer.append(((TaskListItemMarker) node).isChecked() ? "Checked: " : "Unchecked: ");
        else if (node instanceof OrderedList) {
            Integer start = ((OrderedList) node).getMarkerStartNumber();
            int number = start == null ? 1 : start;
            for (Node item = node.getFirstChild(); item != null; item = item.getNext()) {
                writer.append(number++ + ". "); render(item, writer);
            }
        } else {
            if (node instanceof FootnoteDefinition) writer.append("Footnote " + writer.footnote(((FootnoteDefinition) node).getLabel()) + ": ");
            if (node instanceof TableCell && node.getPrevious() != null) writer.append("; ");
            // Links and images contribute their label/alt text, never the hidden destination or title.
            for (Node child = node.getFirstChild(); child != null; child = child.getNext()) render(child, writer);
        }
        if (node instanceof Block || node instanceof TableRow) writer.separate(3);
    }

    /** Whitespace carries pauses without speaking indentation or joining adjacent blocks/cells. */
    private static final class SpeechWriter {
        final StringBuilder text = new StringBuilder();
        // Use the parser's own label normalization, including case-insensitive references.
        final DefinitionMap<Integer> footnotes = new DefinitionMap<>(Integer.class);
        int separator;
        int footnote(String label) {
            Integer number = footnotes.get(label);
            if (number == null) { number = footnotes.values().size() + 1; footnotes.putIfAbsent(label, number); }
            return number;
        }
        void separate(int value) { separator = Math.max(separator, value); }
        void append(String value) {
            for (int offset = 0; offset < value.length();) {
                int point = value.codePointAt(offset); offset += Character.charCount(point);
                if (Character.isWhitespace(point) || Character.isSpaceChar(point)) {
                    separate(point == '\n' || point == '\r' ? 2 : 1); continue;
                }
                if (text.length() > 0 && separator != 0) text.append(separator == 3 ? "\n\n" : separator == 2 ? "\n" : " ");
                separator = 0; text.appendCodePoint(point);
            }
        }
    }
}
