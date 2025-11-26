import React, { useState, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import Papa from 'https://esm.sh/papaparse@5.4.1';

// --- Types ---

interface CsvRow {
  [key: string]: string;
}

interface StrategyStats {
  name: string;
  hitCount: number;
  humanReviewCount: number; // 策略召回量级 (Recall)
  pendingCount: number;
  violationCount: number;
}

interface BasicStats {
  totalRows: number;
  machineRejectCount: number;
  recallCount: number;
  humanViolationCount: number;
  blackSampleTotal: number;
}

interface ReportData {
  mode: 'SINGLE' | 'WEEKLY';
  dateLabel: string;
  
  // For Single Mode
  singleStats?: BasicStats;
  
  // For Weekly Mode
  dates?: string[];
  dailyStatsMap?: Record<string, BasicStats>;
  totalStats?: BasicStats;
  avgStats?: Record<string, string>; // Pre-formatted averages

  // Aggregated Strategy & Tags (Used for both modes)
  strategyList: StrategyStats[];
  tagList: { name: string; count: number }[];
  totalTagCount: number;
  
  // Context for calculations
  aggTotalRows: number;
  aggHumanViolationCount: number;
  aggRecallCount: number;
}

// --- Constants & Mappings ---

const STRATEGY_MAPPING: Record<string, string> = {
  // 原有策略
  'huiboxing_wenxin_model': 'huiboxing文心大模型',
  'service_digital_human_check': '数字人物料机审',
  'service_sync_word': '业务线词表策略',
  'qr_code_detect': '二维码图片识别模型',
  'sensitive_img_model': '敏感图片模型',
  'img_ocr_strategy': '图片ocr策略',
  'service_variant_word_check': '习彭变体词表',

  // === 新增策略 ===
  'duxiaodian_review': '度小店审核',
  'service_short_text_check': '短文本机审',
  'sensitive_hardface': '敏感人脸模型',
  'service_word_3s_check': '3S敏感词策略'
};

const WEEKLY_KEY = 'ALL_WEEKLY_REPORT';
// const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']; // 不需要了

// --- Helper Functions ---

const formatPercent = (numerator: number, denominator: number, decimals: number = 2): string => {
  if (denominator === 0) return (0).toFixed(decimals);
  return ((numerator / denominator) * 100).toFixed(decimals);
};

const formatDecimal = (val: number, decimals: number = 2): string => {
  return val.toFixed(decimals);
};

// Updated regex to support more date formats (-, /, ., Chinese)
const extractDate = (dateStr: string): string | null => {
  if (!dateStr) return null;
  // Match YYYY/MM/DD, YYYY-MM-DD, YYYY.MM.DD, YYYY年MM月DD日
  const match = dateStr.match(/(\d{4})[\.\-\/年](\d{1,2})[\.\-\/月](\d{1,2})/);
  if (match) {
    const year = match[1];
    const month = match[2].padStart(2, '0');
    const day = match[3].padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  return null;
};

// 修改点：只返回 MM.DD 格式，去掉星期
const formatDateSimple = (dateStr: string): string => {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  // 直接返回 月.日
  return `${m}.${d}`;
};

// --- Analysis Core ---

// --- Analysis Core (优化版) ---

// --- Analysis Core (Regex 增强版) ---

const analyzeRows = (rows: CsvRow[]) => {
  let totalRows = rows.length;
  let machineRejectCount = 0;
  let recallCount = 0;
  let humanViolationCount = 0;

  const strategyMap = new Map<string, StrategyStats>();
  const tagMap = new Map<string, number>();

  // 定义需要合并的标签映射（解决“虚假宣传”数不上的问题）
  // 如果您希望程序自动把细分标签合并成大类，可以在这里配置
  const TAG_MERGE_MAPPING: Record<string, string> = {
    //'虚假宣传荣誉信息': '虚假宣传',
    //'虚假宣传商品专利信息': '虚假宣传',
    // '虚构被比较价格': '价格虚假', // 如果系统把这个也算进价格虚假，可以解开注释
  };

  rows.forEach(row => {
    // 1. 基础指标统计
    const isSyncReject = row['同步机审状态']?.trim() === '拒绝';
    const isAsyncReject = row['异步机审状态']?.trim() === '拒绝';
    const isMachineReject = isSyncReject || isAsyncReject;
    if (isMachineReject) machineRejectCount++;

    const humanStatus = row['人审状态']?.trim();
    const isHumanSent = !!humanStatus; 
    const isHumanViolation = humanStatus === '拒绝';
    const isHumanPending = humanStatus === '待审';

    if (isHumanSent) recallCount++;
    if (isHumanViolation) humanViolationCount++;

    // 2. 策略统计 (保持不变)
    let rawStrategyValue = row['同步机审命中策略']?.trim();
    if (!rawStrategyValue) {
      rawStrategyValue = row['异步机审命中策略']?.trim();
    }

    if (rawStrategyValue) {
      const allStrategies = rawStrategyValue.split('&&');
      allStrategies.forEach(rawName => {
          const cleanName = rawName.trim();
          if (!cleanName) return;
          const strategyName = STRATEGY_MAPPING[cleanName] || cleanName;

          if (!strategyMap.has(strategyName)) {
            strategyMap.set(strategyName, {
              name: strategyName, hitCount: 0, humanReviewCount: 0, pendingCount: 0, violationCount: 0
            });
          }
          const stats = strategyMap.get(strategyName)!;
          stats.hitCount++;
          if (isHumanSent) stats.humanReviewCount++;
          if (isHumanPending) stats.pendingCount++;
          if (isHumanViolation) stats.violationCount++;
      });
    }

    // 3. 标签统计 (👉 核心修改：使用正则分割 + 映射归类)
    if (isHumanViolation) {
      const rawTags = String(row['人审标签'] || '');
      
      // 【正则切割】
      // 含义：同时支持 &&、$$、斜杠/、加号+、中英文逗号、空格 作为分隔符
      // 这样能解决 "标签A/标签B" 或 "标签A$$标签B" 这种不规范格式
      const tokens = rawTags.split(/&&|\$\$|\+|[,\s，]+/);

      // 使用 Set 去重（防止一行里写了两次同一个标签，导致计数虚高）
      const uniqueTagsInRow = new Set<string>();

      tokens.forEach(t => {
        let tag = t.trim();
        
        // 过滤干扰词
        const isInvalid = !tag || 
          ['通过', '拒绝', '待审', '送审', 'null', '无', '内容涉及', '请修改后重试'].includes(tag);

        if (!isInvalid) {
          // 【归类映射】(解决 37 vs 6 的问题)
          // 如果这个标签在映射表里（比如是“虚假宣传荣誉信息”），就把它变成“虚假宣传”
          if (TAG_MERGE_MAPPING[tag]) {
            tag = TAG_MERGE_MAPPING[tag];
          }
          
          uniqueTagsInRow.add(tag);
        }
      });

      // 统计
      uniqueTagsInRow.forEach(tag => {
        tagMap.set(tag, (tagMap.get(tag) || 0) + 1);
      });
    }
  });

  const blackSampleTotal = machineRejectCount + humanViolationCount;

  return {
    totalRows,
    machineRejectCount,
    recallCount,
    humanViolationCount,
    blackSampleTotal,
    strategyMap,
    tagMap
  };
};



// --- Main Application ---

const App = () => {
  const [file, setFile] = useState<File | null>(null);
  const [encoding, setEncoding] = useState<string>('UTF-8');
  const [rawData, setRawData] = useState<CsvRow[]>([]);
  const [availableDates, setAvailableDates] = useState<string[]>([]);
  const [selectedDate, setSelectedDate] = useState<string>(WEEKLY_KEY);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // --- Data Loading ---

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setError(null);
      setRawData([]);
      setAvailableDates([]);
      setSelectedDate(WEEKLY_KEY);
      setCopied(false);
    }
  };

  const processFile = () => {
    if (!file) return;
    setLoading(true);
    setError(null);
    setCopied(false);

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      encoding: encoding,
      complete: (results) => {
        const data = results.data as CsvRow[];
        if (data.length === 0) {
          setError("CSV 文件为空或解析失败");
          setLoading(false);
          return;
        }

        const firstRow = data[0];
        if (!firstRow['异步机审入审时间'] && !firstRow['同步机审状态']) {
          setError("警告：关键列未找到，请检查 CSV 编码是否正确 (建议尝试 GBK)");
        }

        setRawData(data);

        const dates = new Set<string>();
        data.forEach(row => {
          const d = extractDate(row['异步机审入审时间']);
          if (d) dates.add(d);
        });

        const sortedDates = Array.from(dates).sort(); // Sort ASC for columns
        setAvailableDates(sortedDates);
        setLoading(false);
      },
      error: (err: any) => {
        setError(`解析错误: ${err.message}`);
        setLoading(false);
      }
    });
  };

  // --- Report Generation Logic ---

  const report = useMemo<ReportData | null>(() => {
    if (rawData.length === 0) return null;

    // --- Mode 1: Weekly/Overall ---
    if (selectedDate === WEEKLY_KEY) {
      let dates = availableDates; // Already sorted ASC

      // --- NOISE FILTERING LOGIC ---
      if (dates.length > 1) {
          const dailyCounts = dates.map(d => {
              return rawData.filter(r => extractDate(r['异步机审入审时间']) === d).length;
          });
          const maxVolume = Math.max(...dailyCounts);
          
          if (maxVolume > 100) {
             const threshold = Math.max(5, maxVolume * 0.005);
             dates = dates.filter((d, i) => dailyCounts[i] > threshold);
          }
      }
      
      const dailyStatsMap: Record<string, BasicStats> = {};
      
      // Accumulators for aggregation
      let aggTotalRows = 0;
      let aggMachineReject = 0;
      let aggRecall = 0;
      let aggHumanViolation = 0;
      let aggBlackSample = 0;
      
      // Rates accumulation for averaging
      let sumRecallRate = 0;
      let sumPrecision = 0;
      let sumRiskLevel = 0;

      const aggStrategyMap = new Map<string, StrategyStats>();
      const aggTagMap = new Map<string, number>();

      dates.forEach(d => {
        const dayRows = rawData.filter(r => extractDate(r['异步机审入审时间']) === d);
        const stats = analyzeRows(dayRows);
        dailyStatsMap[d] = stats;

        // Sum Totals
        aggTotalRows += stats.totalRows;
        aggMachineReject += stats.machineRejectCount;
        aggRecall += stats.recallCount;
        aggHumanViolation += stats.humanViolationCount;
        aggBlackSample += stats.blackSampleTotal;

        // Sum Rates (for simple average calc)
        const recallRate = stats.totalRows > 0 ? (stats.recallCount / stats.totalRows) * 100 : 0;
        const precision = stats.recallCount > 0 ? (stats.humanViolationCount / stats.recallCount) * 100 : 0;
        const risk = stats.totalRows > 0 ? (stats.blackSampleTotal / stats.totalRows) * 100 : 0;

        sumRecallRate += recallRate;
        sumPrecision += precision;
        sumRiskLevel += risk;

        // Aggregate Strategies
        stats.strategyMap.forEach((val, key) => {
           const exist = aggStrategyMap.get(key);
           if (!exist) {
             aggStrategyMap.set(key, { ...val });
           } else {
             exist.hitCount += val.hitCount;
             exist.humanReviewCount += val.humanReviewCount;
             exist.pendingCount += val.pendingCount;
             exist.violationCount += val.violationCount;
           }
        });

        // Aggregate Tags
        stats.tagMap.forEach((count, tag) => {
           aggTagMap.set(tag, (aggTagMap.get(tag) || 0) + count);
        });
      });

      // Prepare Total Stats (Summed)
      const totalStats: BasicStats = {
        totalRows: aggTotalRows,
        machineRejectCount: aggMachineReject,
        recallCount: aggRecall,
        humanViolationCount: aggHumanViolation,
        blackSampleTotal: aggBlackSample
      };

      // Prepare Average Stats
      const dayCount = dates.length || 1;
      const avgStats = {
        totalRows: formatDecimal(aggTotalRows / dayCount, 2),
        machineRejectCount: formatDecimal(aggMachineReject / dayCount, 3),
        recallCount: formatDecimal(aggRecall / dayCount, 2),
        humanViolationCount: formatDecimal(aggHumanViolation / dayCount, 2),
        blackSampleTotal: formatDecimal(aggBlackSample / dayCount, 0),
        
        recallRate: formatDecimal(sumRecallRate / dayCount, 2) + '%',
        precision: formatDecimal(sumPrecision / dayCount, 2) + '%',
        riskLevel: formatDecimal(sumRiskLevel / dayCount, 2) + '%'
      };

      // Sort Lists
      const strategyList = Array.from(aggStrategyMap.values()).sort((a, b) => b.hitCount - a.hitCount);
      const tagList = Array.from(aggTagMap.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 35);
      const totalTagCount = tagList.reduce((acc, curr) => acc + curr.count, 0);

      return {
        mode: 'WEEKLY',
        dateLabel: '整体周报',
        dates,
        dailyStatsMap,
        totalStats,
        avgStats,
        strategyList,
        tagList,
        totalTagCount,
        aggTotalRows,
        aggHumanViolationCount: aggHumanViolation,
        aggRecallCount: aggRecall
      };

    } 
    // --- Mode 2: Single Day ---
    else {
      const dayRows = rawData.filter(r => extractDate(r['异步机审入审时间']) === selectedDate);
      const stats = analyzeRows(dayRows);
      
      const strategyList = Array.from(stats.strategyMap.values()).sort((a, b) => b.hitCount - a.hitCount);
      const tagList = Array.from(stats.tagMap.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 35);
      const totalTagCount = tagList.reduce((acc, curr) => acc + curr.count, 0);

      return {
        mode: 'SINGLE',
        dateLabel: selectedDate,
        singleStats: stats,
        strategyList,
        tagList,
        totalTagCount,
        aggTotalRows: stats.totalRows,
        aggHumanViolationCount: stats.humanViolationCount,
        aggRecallCount: stats.recallCount
      };
    }

  }, [rawData, selectedDate, availableDates]);


  // --- Generate Markdown ---

  const generateMarkdown = () => {
    if (!report) return '';

    // Calculate real black sample for Section 3 (Machine + Human)
    const stats = report.mode === 'WEEKLY' ? report.totalStats : report.singleStats;
    const realBlackSample = (stats?.machineRejectCount || 0) + (stats?.humanViolationCount || 0);

    let md = `### 一、基本统计分析工作\n`;
    md += `**[${report.dateLabel}] 大盘情况**\n`;
    md += `*包括但不限于送审量级、策略召回量级、违规量级、大盘风险水位（违规量级/送审量级）等*\n\n`;

    // --- Section 1: Matrix or Single ---
    if (report.mode === 'WEEKLY' && report.dates && report.dailyStatsMap && report.totalStats && report.avgStats) {
       // Matrix Header
       // -------------------------------------------------------
       // 修改点：这里调用 formatDateSimple 而不是 formatDateWithWeekday
       const dateHeaders = report.dates.map(d => formatDateSimple(d)).join(' | ');
       // -------------------------------------------------------
       md += `| 指标 | ${dateHeaders} | 总计 | 7天日均 |\n`;
       md += `| :--- | ${report.dates.map(() => ':---').join(' | ')} | :--- | :--- |\n`;
       
       // Helper for rows
       const renderRow = (label: string, key: keyof BasicStats, isPercent: boolean = false, denomKey?: keyof BasicStats) => {
         let rowStr = `| **${label}** |`;
         // Days
         report.dates!.forEach(d => {
            const s = report.dailyStatsMap![d];
            const val = s[key];
            if (isPercent && denomKey) {
                rowStr += ` ${formatPercent(val, s[denomKey], 2)}% |`;
            } else {
                rowStr += ` ${val} |`;
            }
         });
         // Total
         const totalVal = report.totalStats![key];
         if (isPercent && denomKey) {
             rowStr += ` ${formatPercent(totalVal, report.totalStats![denomKey], 2)}% |`;
         } else {
             rowStr += ` ${totalVal} |`;
         }
         // Avg
         let avgVal = '';
         if (label === '送审量级') avgVal = report.avgStats!.totalRows;
         else if (label === '机审拒绝') avgVal = report.avgStats!.machineRejectCount;
         else if (label === '策略召回量级（送人审）') avgVal = report.avgStats!.recallCount;
         else if (label === '策略总命中率') avgVal = report.avgStats!.recallRate;
         else if (label === '人审判定违规量级') avgVal = report.avgStats!.humanViolationCount;
         else if (label === '策略总精确率') avgVal = report.avgStats!.precision;
         else if (label === '黑样本总数') avgVal = report.avgStats!.blackSampleTotal;
         else if (label === '大盘风险水位') avgVal = report.avgStats!.riskLevel;

         rowStr += ` ${avgVal} |\n`;
         return rowStr;
       };

       md += renderRow('送审量级', 'totalRows');
       md += renderRow('机审拒绝', 'machineRejectCount');
       md += renderRow('策略召回量级（送人审）', 'recallCount');
       md += renderRow('策略总命中率', 'recallCount', true, 'totalRows');
       md += renderRow('人审判定违规量级', 'humanViolationCount');
       md += renderRow('策略总精确率', 'humanViolationCount', true, 'recallCount');
       md += renderRow('黑样本总数', 'blackSampleTotal');
       md += renderRow('大盘风险水位', 'blackSampleTotal', true, 'totalRows');
       md += '\n';

    } else if (report.mode === 'SINGLE' && report.singleStats) {
       const s = report.singleStats;
       const recallRate = formatPercent(s.recallCount, s.totalRows, 2);
       const strategyPrecision = formatPercent(s.humanViolationCount, s.recallCount, 2);
       const riskLevel = formatPercent(s.blackSampleTotal, s.totalRows, 2);

       md += `| 指标 | 数值 | 备注 |\n| :--- | :--- | :--- |\n`;
       md += `| **送审量级** | ${s.totalRows} | |\n`;
       md += `| **机审拒绝** | ${s.machineRejectCount} | |\n`;
       md += `| **策略召回量级（送人审）** | ${s.recallCount} | |\n`;
       md += `| **策略总命中率** | ${recallRate}% | |\n`;
       md += `| **人审判定违规量级** | ${s.humanViolationCount} | |\n`;
       md += `| **策略总精确率** | ${strategyPrecision}% | |\n`;
       md += `| **黑样本总数** | ${s.blackSampleTotal} | 策略召回+人审违规 |\n`;
       md += `| **大盘风险水位** | ${riskLevel}% | |\n\n`;
    }

    // --- Section 2: Strategies ---
    md += `### 二、策略情况\n`;
    md += `*(策略召回量级/送审量级)、策略精确率（违规量级/策略召回量级）*\n\n`;
    md += `| 策略名称 | 策略命中数量 | 策略命中率 | 送人审(含待审) | 策略下违规数量 | 策略精确率 |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- | :--- |\n`;

    report.strategyList.forEach(s => {
      const hitRate = formatPercent(s.hitCount, report.aggTotalRows, 4);
      const precision = formatPercent(s.violationCount, s.humanReviewCount, 2);
      md += `| ${s.name} | ${s.hitCount} | ${hitRate}% | ${s.humanReviewCount}<br>(待审：${s.pendingCount}) | ${s.violationCount} | ${precision}% |\n`;
    });
    md += `\n`;

    // --- Section 3: Tags ---
    md += `### 三、大盘风险分布\n`;
    md += `*(by标签统计量级、违规标签占比：违规标签a/总违规量级、违规标签风险水位：违规标签a/送审量级)*\n`;
    md += `*   人审违规数量：${report.aggHumanViolationCount}\n`;
    md += `*   机审拒绝+人审违规数量：${realBlackSample}\n\n`;
    
    md += `| 人审标签 | 数量 | 违规标签占比 | 风险水位 |\n`;
    md += `| :--- | :--- | :--- | :--- |\n`;

    let totalRiskSum = 0;
    report.tagList.forEach(t => {
      const share = formatPercent(t.count, report.aggHumanViolationCount, 4);
      const riskVal = (t.count / report.aggTotalRows) * 100;
      totalRiskSum += riskVal;
      const risk = riskVal.toFixed(4);
      md += `| ${t.name} | ${t.count} | ${share}% | ${risk}% |\n`;
    });
    
    md += `| **汇总** | **${report.totalTagCount}** | **100.00%** | **${totalRiskSum.toFixed(4)}%** |`;

    return md;
  };

  const markdownOutput = generateMarkdown();

  const handleCopy = () => {
    navigator.clipboard.writeText(markdownOutput).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  // --- Render ---

  return (
    <div style={{ maxWidth: '1400px', margin: '0 auto', padding: '20px', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      
      <header style={{ marginBottom: '30px', borderBottom: '1px solid #e5e7eb', paddingBottom: '20px' }}>
        <h1 style={{ margin: 0, color: '#111827', fontSize: '24px' }}>慧播星风控周报生成器</h1>
      </header>

      {/* Controls */}
      <div style={{ background: '#fff', padding: '20px', borderRadius: '12px', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06)', marginBottom: '24px' }}>
        <div style={{ display: 'flex', gap: '24px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          
          <div>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600', fontSize: '14px', color: '#374151' }}>1. 文件编码</label>
            <select 
              value={encoding} 
              onChange={(e) => setEncoding(e.target.value)}
              style={{ padding: '8px 12px', borderRadius: '6px', border: '1px solid #d1d5db', backgroundColor: '#f9fafb' }}
            >
              <option value="UTF-8">UTF-8</option>
              <option value="GBK">GBK</option>
            </select>
          </div>

          <div style={{ flex: 1, minWidth: '200px' }}>
            <label style={{ display: 'block', marginBottom: '8px', fontWeight: '600', fontSize: '14px', color: '#374151' }}>2. 上传 CSV</label>
            <input 
              type="file" 
              accept=".csv" 
              onChange={handleFileChange}
              style={{ padding: '6px', border: '1px solid #d1d5db', borderRadius: '6px', width: '100%', backgroundColor: '#fff' }} 
            />
          </div>

          <div>
             <button 
               onClick={processFile} 
               disabled={!file || loading}
               style={{ 
                 padding: '10px 20px', 
                 background: (!file || loading) ? '#9ca3af' : '#2563eb', 
                 color: 'white', 
                 border: 'none', 
                 borderRadius: '6px', 
                 cursor: (!file || loading) ? 'not-allowed' : 'pointer'
               }}
             >
               {loading ? '分析中...' : '开始分析'}
             </button>
          </div>
        </div>

        {availableDates.length > 0 && (
          <div style={{ marginTop: '20px', borderTop: '1px solid #e5e7eb', paddingTop: '20px' }}>
             <label style={{ display: 'block', marginBottom: '8px', fontWeight: 'bold', color: '#059669' }}>3. 选择统计模式</label>
             <select 
                value={selectedDate} 
                onChange={(e) => setSelectedDate(e.target.value)}
                style={{ padding: '8px 12px', borderRadius: '6px', border: '2px solid #059669', minWidth: '300px', fontSize: '16px', fontWeight: '500', color: '#064e3b' }}
             >
                <option value={WEEKLY_KEY}>📊 整体周报 (汇总 + 每日明细)</option>
                <optgroup label="单日视图">
                  {availableDates.map(d => <option key={d} value={d}>{d}</option>)}
                </optgroup>
             </select>
          </div>
        )}
        
        {error && (
          <div style={{ marginTop: '16px', color: '#991b1b', background: '#fef2f2', padding: '12px', borderRadius: '6px', border: '1px solid #fecaca', fontSize: '14px' }}>
            🚨 {error}
          </div>
        )}
      </div>

      {/* Report View */}
      {report && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '24px' }}>
          
          <div style={{ background: '#fff', padding: '24px', borderRadius: '12px', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)' }}>
             {/* Header Section */}
             <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', borderBottom: '2px solid #3b82f6', paddingBottom: '12px' }}>
                <h2 style={{ fontSize: '18px', fontWeight: '700', color: '#1f2937', margin: 0 }}>
                  {report.mode === 'WEEKLY' ? '📊 整体周报概览' : `📅 单日报表 (${report.dateLabel})`}
                </h2>
                <button 
                  onClick={handleCopy}
                  style={{ background: copied ? '#10b981' : '#3b82f6', color: 'white', border: 'none', padding: '6px 16px', borderRadius: '6px', cursor: 'pointer', fontSize: '14px', fontWeight: '500' }}
                >
                  {copied ? '✓ 已复制 Markdown' : '复制 Markdown'}
                </button>
             </div>

             {/* 1. General Stats Table (Matrix or Single) */}
             <SectionTitle title="一、大盘情况" />
             <SectionDesc text="包括但不限于送审量级、策略召回量级、违规量级、大盘风险水位（违规量级/送审量级）等" />
             {report.mode === 'WEEKLY' && report.dates && report.totalStats ? (
                <div style={{ overflowX: 'auto' }}>
                  <Table>
                    <thead>
                      <tr>
                         <Th>指标</Th>
                         {/* Update: Show formatted date simple */}
                         {report.dates.map(d => <Th key={d}>{formatDateSimple(d)}</Th>)}
                         <Th>总计</Th>
                         <Th>7天日均</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {/* Rows helper */}
                      {[
                        { label: '送审量级', key: 'totalRows' },
                        { label: '机审拒绝', key: 'machineRejectCount' },
                        { label: '策略召回量级（送人审）', key: 'recallCount' },
                        { label: '策略总命中率', key: 'recallCount', denom: 'totalRows' },
                        { label: '人审判定违规量级', key: 'humanViolationCount' },
                        { label: '策略总精确率', key: 'humanViolationCount', denom: 'recallCount' },
                        { label: '黑样本总数', key: 'blackSampleTotal' },
                        { label: '大盘风险水位', key: 'blackSampleTotal', denom: 'totalRows' },
                      ].map((item, i) => (
                        <tr key={i} style={item.label.includes('黑样本') || item.label.includes('风险') ? {background: '#fff1f2'} : {}}>
                          <Td><strong>{item.label}</strong></Td>
                          {report.dates!.map(d => {
                             const s = report.dailyStatsMap![d];
                             // @ts-ignore
                             const val = s[item.key];
                             if (item.denom) {
                               // @ts-ignore
                               return <Td key={d}>{formatPercent(val, s[item.denom], 2)}%</Td>;
                             }
                             return <Td key={d}>{val}</Td>;
                          })}
                          {/* Total Column */}
                          <Td>
                             {item.denom 
                                // @ts-ignore
                                ? `${formatPercent(report.totalStats[item.key], report.totalStats[item.denom], 2)}%`
                                // @ts-ignore
                                : report.totalStats[item.key]
                             }
                          </Td>
                          {/* Avg Column */}
                          <Td>
                             {/* Map to pre-calculated avgStats */}
                             { item.label === '送审量级' && report.avgStats!.totalRows }
                             { item.label === '机审拒绝' && report.avgStats!.machineRejectCount }
                             { item.label === '策略召回量级（送人审）' && report.avgStats!.recallCount }
                             { item.label === '策略总命中率' && report.avgStats!.recallRate }
                             { item.label === '人审判定违规量级' && report.avgStats!.humanViolationCount }
                             { item.label === '策略总精确率' && report.avgStats!.precision }
                             { item.label === '黑样本总数' && report.avgStats!.blackSampleTotal }
                             { item.label === '大盘风险水位' && report.avgStats!.riskLevel }
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
             ) : (
                // Single View Table
                <div style={{ maxWidth: '600px' }}>
                  <Table>
                    <thead>
                      <tr><Th>指标</Th><Th>数值</Th></tr>
                    </thead>
                    <tbody>
                        {report.singleStats && (
                          <>
                            <tr><Td>送审量级</Td><Td>{report.singleStats.totalRows}</Td></tr>
                            <tr><Td>机审拒绝</Td><Td>{report.singleStats.machineRejectCount}</Td></tr>
                            <tr><Td>策略召回量级</Td><Td>{report.singleStats.recallCount}</Td></tr>
                            <tr><Td>策略总命中率</Td><Td>{formatPercent(report.singleStats.recallCount, report.singleStats.totalRows, 2)}%</Td></tr>
                            <tr><Td>人审判定违规</Td><Td>{report.singleStats.humanViolationCount}</Td></tr>
                            <tr><Td>策略总精确率</Td><Td>{formatPercent(report.singleStats.humanViolationCount, report.singleStats.recallCount, 2)}%</Td></tr>
                            <tr style={{background:'#fff1f2'}}><Td>黑样本总数</Td><Td>{report.singleStats.blackSampleTotal}</Td></tr>
                            <tr style={{background:'#fff1f2'}}><Td>大盘风险水位</Td><Td>{formatPercent(report.singleStats.blackSampleTotal, report.singleStats.totalRows, 2)}%</Td></tr>
                          </>
                        )}
                    </tbody>
                  </Table>
                </div>
             )}

             {/* 2. Strategies */}
             <SectionTitle title="二、策略情况" />
             <SectionDesc text="(策略召回量级/送审量级)、策略精确率（违规量级/策略召回量级）" />
             <div style={{ overflowX: 'auto' }}>
               <Table>
                 <thead>
                   <tr>
                     <Th>策略名称</Th>
                     <Th>命中数</Th>
                     <Th>命中率</Th>
                     <Th>送人审</Th>
                     <Th>违规数</Th>
                     <Th>精确率</Th>
                   </tr>
                 </thead>
                 <tbody>
                   {report.strategyList.map((s, i) => (
                     <tr key={i}>
                       <Td>{s.name}</Td>
                       <Td>{s.hitCount}</Td>
                       <Td>{formatPercent(s.hitCount, report.aggTotalRows, 4)}%</Td>
                       <Td>{s.humanReviewCount} <span style={{fontSize:'0.85em', color:'#6b7280'}}>(待审：{s.pendingCount})</span></Td>
                       <Td>{s.violationCount}</Td>
                       <Td>{formatPercent(s.violationCount, s.humanReviewCount, 2)}%</Td>
                     </tr>
                   ))}
                 </tbody>
               </Table>
             </div>

             {/* 3. Tags */}
             <SectionTitle title="三、大盘风险分布" />
             <SectionDesc text="(by标签统计量级、违规标签占比：违规标签a/总违规量级、违规标签风险水位：违规标签a/送审量级)" />
             <div style={{ marginBottom: '10px', fontSize: '13px', color: '#374151' }}>
                <div>• 人审违规数量：{report.aggHumanViolationCount}</div>
                <div>• 机审拒绝+人审违规数量：{(report.mode === 'WEEKLY' ? report.totalStats?.machineRejectCount : report.singleStats?.machineRejectCount) + (report.mode === 'WEEKLY' ? report.totalStats?.humanViolationCount : report.singleStats?.humanViolationCount)}</div>
             </div>
             <Table>
               <thead>
                 <tr>
                   <Th>标签名称</Th>
                   <Th>数量</Th>
                   <Th>违规占比</Th>
                   <Th>风险水位</Th>
                 </tr>
               </thead>
               <tbody>
                 {report.tagList.map((t, i) => (
                    <tr key={i}>
                      <Td>{t.name}</Td>
                      <Td>{t.count}</Td>
                      <Td>{formatPercent(t.count, report.aggHumanViolationCount, 4)}%</Td>
                      <Td>{formatPercent(t.count, report.aggTotalRows, 4)}%</Td>
                    </tr>
                 ))}
                  <tr style={{ fontWeight: 'bold', background: '#f9fafb' }}>
                     <Td>汇总</Td>
                     <Td>{report.totalTagCount}</Td>
                     <Td>100.00%</Td>
                     <Td>{report.tagList.reduce((acc, t) => acc + (t.count / report.aggTotalRows) * 100, 0).toFixed(4)}%</Td>
                  </tr>
               </tbody>
             </Table>

          </div>
        </div>
      )}
    </div>
  );
};

// --- Styled Components ---

const SectionTitle = ({title}: {title: string}) => (
  <h3 style={{ fontSize: '15px', color: '#4b5563', marginTop: '24px', marginBottom: '12px', fontWeight: '600' }}>{title}</h3>
);

const SectionDesc = ({text}: {text: string}) => (
  <p style={{ fontSize: '13px', color: '#6b7280', marginTop: '-8px', marginBottom: '16px', fontStyle: 'italic' }}>{text}</p>
);

const Table = ({children}: {children: React.ReactNode}) => (
  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', border: '1px solid #e0e0e0', whiteSpace: 'nowrap' }}>
    {children}
  </table>
);

const Th = ({children}: {children: React.ReactNode}) => (
  <th style={{ padding: '10px 12px', textAlign: 'center', fontWeight: '600', color: '#ffffff', borderBottom: '1px solid #3b82f6', background: '#3b82f6' }}>
    {children}
  </th>
);

const Td = ({children}: {children: React.ReactNode}) => (
  <td style={{ padding: '10px 12px', borderBottom: '1px solid #f0f0f0', color: '#1f2937', textAlign: 'center', borderRight: '1px solid #f0f0f0' }}>
    {children}
  </td>
);

const root = createRoot(document.getElementById('root')!);
root.render(<App />);