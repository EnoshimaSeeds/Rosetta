function save_pub_fig(fig, filename, widthCm, heightCm)
%SAVE_PUB_FIG  Size a figure to its final printed dimensions and export it.
%   save_pub_fig(fig, 'fig2', 8.8, 6.5) writes fig2.pdf (vector) and
%   fig2.png (600 dpi). Width and height are in centimetres and should be
%   the size the figure will have on the page (single column ~8.8 cm,
%   double column ~18 cm; check the target template).
%
%   Requires MATLAB R2020a or later (exportgraphics).
%   NOTE: written without access to MATLAB; run it once and check the
%   output before relying on it.

    arguments
        fig (1,1) matlab.ui.Figure
        filename (1,:) char
        widthCm (1,1) double {mustBePositive} = 8.8
        heightCm (1,1) double {mustBePositive} = 6.5
    end

    % Okabe-Ito colour-blind-safe order (black first).
    okabeIto = [0 0 0; 0 114 178; 213 94 0; 0 158 115; ...
                230 159 0; 86 180 233; 204 121 167; 240 228 66] / 255;

    set(fig, 'Units', 'centimeters', 'Color', 'w');
    pos = get(fig, 'Position');
    set(fig, 'Position', [pos(1) pos(2) widthCm heightCm]);

    ax = findall(fig, 'Type', 'axes');
    set(ax, 'FontName', 'Arial', 'FontSize', 8, 'LineWidth', 0.8, ...
            'Box', 'off', 'TickDir', 'out', 'ColorOrder', okabeIto);
    set(findall(fig, 'Type', 'text'), 'FontName', 'Arial', 'FontSize', 8);
    set(findall(fig, 'Type', 'legend'), 'Box', 'off', 'FontSize', 7);

    exportgraphics(fig, [filename '.pdf'], 'ContentType', 'vector');
    exportgraphics(fig, [filename '.png'], 'Resolution', 600);
end
